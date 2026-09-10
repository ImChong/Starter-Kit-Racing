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

const _origin = new THREE.Vector3();
const _target = new THREE.Vector3();
const _probe = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();

function makeTransparent( material ) {

	const faded = material.clone();
	faded.transparent = true;
	faded.depthWrite = true;
	return faded;

}

// Per-instance alpha for InstancedMesh: one instance of a forest can fade
// without taking the rest of the forest with it.
function makeInstancedFadeMaterial( material ) {

	const faded = makeTransparent( material );

	faded.onBeforeCompile = ( shader ) => {

		shader.vertexShader = shader.vertexShader
			.replace( '#include <common>', '#include <common>\nattribute float instanceAlpha;\nvarying float vInstanceAlpha;' )
			.replace( '#include <begin_vertex>', '#include <begin_vertex>\nvInstanceAlpha = instanceAlpha;' );

		shader.fragmentShader = shader.fragmentShader
			.replace( '#include <common>', '#include <common>\nvarying float vInstanceAlpha;' )
			.replace( '#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vInstanceAlpha;' );

	};

	// Without its own cache key this would share a compiled program with the
	// untouched original material.
	faded.customProgramCacheKey = () => 'instance-alpha';

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

		const original = mesh.material;

		if ( mesh.isInstancedMesh ) {

			const count = mesh.count;
			const alphas = new Float32Array( count ).fill( 1 );
			const attribute = new THREE.InstancedBufferAttribute( alphas, 1 );
			attribute.setUsage( THREE.DynamicDrawUsage );
			mesh.geometry.setAttribute( 'instanceAlpha', attribute );

			return {
				instanced: true,
				original,
				faded: makeInstancedFadeMaterial( original ),
				attribute,
				opacities: new Map(),
			};

		}

		return {
			instanced: false,
			original,
			faded: Array.isArray( original ) ? original.map( makeTransparent ) : makeTransparent( original ),
			opacity: 1,
		};

	}

	setOpacity( state, opacity ) {

		if ( Array.isArray( state.faded ) ) {

			for ( const material of state.faded ) material.opacity = opacity;

		} else {

			state.faded.opacity = opacity;

		}

	}

	collectHits( camera, targetPos ) {

		const hits = this.hits;
		hits.clear();

		_target.copy( targetPos );
		_origin.copy( camera.position );

		const distance = _origin.distanceTo( _target );
		if ( distance <= TARGET_MARGIN ) return;

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
				if ( ! mesh.isMesh || ! mesh.visible ) continue;

				let ids = hits.get( mesh );
				if ( ids === undefined ) {

					ids = new Set();
					hits.set( mesh, ids );

				}

				ids.add( mesh.isInstancedMesh ? hit.instanceId : - 1 );

			}

		}

		this.intersections.length = 0;

	}

	update( dt, camera, targetPos ) {

		this.collectHits( camera, targetPos );

		for ( const mesh of this.hits.keys() ) {

			if ( ! this.states.has( mesh ) ) this.states.set( mesh, this.createState( mesh ) );

		}

		const t = 1 - Math.exp( - dt * FADE_RATE );

		for ( const [ mesh, state ] of this.states ) {

			const ids = this.hits.get( mesh );

			if ( state.instanced ) {

				const opacities = state.opacities;

				if ( ids !== undefined ) {

					for ( const id of ids ) if ( ! opacities.has( id ) ) opacities.set( id, 1 );

				}

				for ( const [ id, opacity ] of opacities ) {

					const target = ids !== undefined && ids.has( id ) ? FADE_OPACITY : 1;
					const next = opacity + ( target - opacity ) * t;

					if ( target === 1 && next > 0.99 ) {

						opacities.delete( id );
						state.attribute.setX( id, 1 );

					} else {

						opacities.set( id, next );
						state.attribute.setX( id, next );

					}

				}

				state.attribute.needsUpdate = true;

				if ( opacities.size === 0 ) {

					mesh.material = state.original;
					this.states.delete( mesh );

				} else {

					mesh.material = state.faded;

				}

			} else {

				const target = ids !== undefined ? FADE_OPACITY : 1;
				state.opacity += ( target - state.opacity ) * t;

				if ( target === 1 && state.opacity > 0.99 ) {

					mesh.material = state.original;
					this.states.delete( mesh );

				} else {

					this.setOpacity( state, state.opacity );
					mesh.material = state.faded;

				}

			}

		}

	}

}
