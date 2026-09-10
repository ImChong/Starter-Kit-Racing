import * as THREE from 'three';

// Anything the ray hits between the camera and the vehicle fades out, then
// fades back once it stops blocking the view.
const FADE_OPACITY = 0.3;
const FADE_RATE = 12;

// Stop the ray short of the vehicle so the road it sits on never registers.
const TARGET_MARGIN = 0.6;

// Extra probes around the vehicle so narrow posts and tree trunks still count.
const PROBE_OFFSETS = [
	[ 0, 0 ],
	[ - 0.7, 0 ],
	[ 0.7, 0 ],
	[ 0, 0.7 ],
];

// Position quantization used to weld coincident vertices when splitting a
// geometry into connected components.
const WELD_PRECISION = 1e-4;

// Faded occluders draw before every other transparent object — the drift marks
// sit at -1 — so whatever they were hiding blends back over them.
const FADED_RENDER_ORDER = - 2;

const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

// Each track piece is one merged mesh — the finish line, for instance, holds
// the road slab and the arch in a single geometry. Splitting it into connected
// components lets the arch fade on its own while the road it spans stays solid.
function getComponents( geometry ) {

	let components = geometry.userData.occlusionComponents;
	if ( components !== undefined ) return components;

	const position = geometry.getAttribute( 'position' );
	const index = geometry.getIndex();
	const vertexCount = position.count;

	const parent = new Int32Array( vertexCount );
	for ( let i = 0; i < vertexCount; i ++ ) parent[ i ] = i;

	function find( a ) {

		while ( parent[ a ] !== a ) {

			parent[ a ] = parent[ parent[ a ] ];
			a = parent[ a ];

		}

		return a;

	}

	function union( a, b ) {

		a = find( a );
		b = find( b );
		if ( a !== b ) parent[ b ] = a;

	}

	// Vertices at the same position belong to the same piece even when the
	// exporter split them for hard edges.
	const welded = new Map();

	for ( let i = 0; i < vertexCount; i ++ ) {

		const key = Math.round( position.getX( i ) / WELD_PRECISION ) + '_' +
			Math.round( position.getY( i ) / WELD_PRECISION ) + '_' +
			Math.round( position.getZ( i ) / WELD_PRECISION );

		const previous = welded.get( key );
		if ( previous === undefined ) welded.set( key, i );
		else union( previous, i );

	}

	const triangleCount = index ? index.count / 3 : vertexCount / 3;

	for ( let t = 0; t < triangleCount; t ++ ) {

		const a = index ? index.getX( t * 3 ) : t * 3;
		const b = index ? index.getX( t * 3 + 1 ) : t * 3 + 1;
		const c = index ? index.getX( t * 3 + 2 ) : t * 3 + 2;

		union( a, b );
		union( a, c );

	}

	const ids = new Map();
	const vertexComponents = new Float32Array( vertexCount );

	for ( let i = 0; i < vertexCount; i ++ ) {

		const root = find( i );
		let id = ids.get( root );

		if ( id === undefined ) {

			id = ids.size;
			ids.set( root, id );

		}

		vertexComponents[ i ] = id;

	}

	const faceComponents = new Uint16Array( triangleCount );

	for ( let t = 0; t < triangleCount; t ++ ) {

		faceComponents[ t ] = vertexComponents[ index ? index.getX( t * 3 ) : t * 3 ];

	}

	geometry.setAttribute( 'componentId', new THREE.BufferAttribute( vertexComponents, 1 ) );

	components = { count: ids.size, faceComponents };
	geometry.userData.occlusionComponents = components;

	return components;

}

// One byte of alpha per component, looked up in the shader by component id.
function createComponentTexture( count ) {

	const data = new Uint8Array( count ).fill( 255 );
	const texture = new THREE.DataTexture( data, count, 1, THREE.RedFormat, THREE.UnsignedByteType );

	// One texel per component: no filtering, no mipmaps, and byte-aligned rows
	// so a component count that is not a multiple of four still reads back.
	texture.magFilter = THREE.NearestFilter;
	texture.minFilter = THREE.NearestFilter;
	texture.generateMipmaps = false;
	texture.unpackAlignment = 1;
	texture.needsUpdate = true;

	return texture;

}

function createFadeMaterial( material, texture, count, instanced ) {

	const faded = Array.isArray( material ) ? material.map( ( m ) => m.clone() ) : material.clone();
	const list = Array.isArray( faded ) ? faded : [ faded ];

	for ( const target of list ) {

		target.transparent = true;

		// Drawing first without writing depth keeps the faded object from
		// masking anything that renders after it.
		target.depthWrite = false;

		target.onBeforeCompile = ( shader ) => {

			shader.uniforms.componentAlpha = { value: texture };
			shader.uniforms.componentCount = { value: count };

			shader.vertexShader = shader.vertexShader
				.replace( '#include <common>', `#include <common>
					attribute float componentId;
					varying float vComponentId;
					${ instanced ? 'attribute float instanceAlpha;\nvarying float vInstanceAlpha;' : '' }` )
				.replace( '#include <begin_vertex>', `#include <begin_vertex>
					vComponentId = componentId;
					${ instanced ? 'vInstanceAlpha = instanceAlpha;' : '' }` );

			shader.fragmentShader = shader.fragmentShader
				.replace( '#include <common>', `#include <common>
					uniform sampler2D componentAlpha;
					uniform float componentCount;
					varying float vComponentId;
					${ instanced ? 'varying float vInstanceAlpha;' : '' }` )
				.replace( '#include <color_fragment>', `#include <color_fragment>
					float componentFade = texture2D( componentAlpha, vec2( ( vComponentId + 0.5 ) / componentCount, 0.5 ) ).r;
					${ instanced
						// Only instances that are themselves fading pick up the
						// component alpha — component ids are shared by every
						// instance of the geometry.
						? 'diffuseColor.a *= 1.0 - ( 1.0 - vInstanceAlpha ) * ( 1.0 - componentFade );'
						: 'diffuseColor.a *= componentFade;' }` );

		};

		// Without its own cache key this would share a compiled program with the
		// untouched original material.
		target.customProgramCacheKey = () => ( instanced ? 'occlusion-instanced' : 'occlusion' );

	}

	return faded;

}

export class OcclusionFade {

	constructor( occluders ) {

		this.occluders = occluders;
		this.raycaster = new THREE.Raycaster();
		this.states = new Map();
		this.hits = new Map();
		this.intersections = [];

	}

	createState( mesh ) {

		const components = getComponents( mesh.geometry );
		const texture = createComponentTexture( components.count );
		const instanced = mesh.isInstancedMesh === true;

		const state = {
			instanced,
			components,
			texture,
			original: mesh.material,
			renderOrder: mesh.renderOrder,
			faded: createFadeMaterial( mesh.material, texture, components.count, instanced ),
			componentAlphas: new Map(),
		};

		if ( instanced ) {

			const alphas = new Float32Array( mesh.count ).fill( 1 );
			const attribute = new THREE.InstancedBufferAttribute( alphas, 1 );
			attribute.setUsage( THREE.DynamicDrawUsage );
			mesh.geometry.setAttribute( 'instanceAlpha', attribute );

			state.attribute = attribute;
			state.instanceAlphas = new Map();

		}

		return state;

	}

	collectHits( camera, targetPos ) {

		const hits = this.hits;
		hits.clear();

		_target.copy( targetPos );
		_origin.copy( camera.position );

		if ( _origin.distanceTo( _target ) <= TARGET_MARGIN ) return;

		_right.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
		_up.set( 0, 1, 0 ).applyQuaternion( camera.quaternion );

		for ( const [ ox, oy ] of PROBE_OFFSETS ) {

			_probe.copy( _target ).addScaledVector( _right, ox ).addScaledVector( _up, oy );
			_dir.subVectors( _probe, _origin );

			const probeDistance = _dir.length();
			if ( probeDistance <= TARGET_MARGIN ) continue;

			this.raycaster.set( _origin, _dir.divideScalar( probeDistance ) );
			this.raycaster.far = probeDistance - TARGET_MARGIN;

			this.intersections.length = 0;
			this.raycaster.intersectObjects( this.occluders, true, this.intersections );

			for ( const hit of this.intersections ) {

				const mesh = hit.object;
				if ( ! mesh.isMesh || ! mesh.visible || hit.faceIndex === undefined ) continue;

				let entry = hits.get( mesh );
				if ( entry === undefined ) {

					entry = { components: new Set(), instances: new Set() };
					hits.set( mesh, entry );

				}

				let state = this.states.get( mesh );
				if ( state === undefined ) {

					state = this.createState( mesh );
					this.states.set( mesh, state );

				}

				entry.components.add( state.components.faceComponents[ hit.faceIndex ] );
				if ( mesh.isInstancedMesh ) entry.instances.add( hit.instanceId );

			}

		}

		this.intersections.length = 0;

	}

	// Steps one set of fading values toward their targets and reports whether
	// any of them are still away from rest.
	stepValues( values, hitIds, restValue, fadeValue, t, apply ) {

		if ( hitIds !== undefined ) {

			for ( const id of hitIds ) if ( ! values.has( id ) ) values.set( id, restValue );

		}

		for ( const [ id, value ] of values ) {

			const target = hitIds !== undefined && hitIds.has( id ) ? fadeValue : restValue;
			const next = value + ( target - value ) * t;

			if ( target === restValue && Math.abs( next - restValue ) < 0.01 ) {

				values.delete( id );
				apply( id, restValue );

			} else {

				values.set( id, next );
				apply( id, next );

			}

		}

		return values.size > 0;

	}

	update( dt, camera, targetPos ) {

		this.collectHits( camera, targetPos );

		const t = 1 - Math.exp( - dt * FADE_RATE );

		for ( const [ mesh, state ] of this.states ) {

			const hit = this.hits.get( mesh );
			const data = state.texture.image.data;

			let fading = this.stepValues(
				state.componentAlphas,
				hit && hit.components,
				1,
				FADE_OPACITY,
				t,
				( id, value ) => data[ id ] = Math.round( value * 255 )
			);

			state.texture.needsUpdate = true;

			if ( state.instanced ) {

				const attribute = state.attribute;

				fading = this.stepValues(
					state.instanceAlphas,
					hit && hit.instances,
					1,
					0,
					t,
					( id, value ) => attribute.setX( id, value )
				) || fading;

				attribute.needsUpdate = true;

			}

			mesh.material = fading ? state.faded : state.original;
			mesh.renderOrder = fading ? FADED_RENDER_ORDER : state.renderOrder;

			if ( ! fading ) this.states.delete( mesh );

		}

	}

}
