import * as THREE from 'three';

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _lookPoint = new THREE.Vector3();

export const CAMERA_MODE_FIXED = 'fixed';
export const CAMERA_MODE_FOLLOW = 'follow';

function lerpAngle( a, b, t ) {

	let diff = b - a;
	while ( diff > Math.PI ) diff -= Math.PI * 2;
	while ( diff < - Math.PI ) diff += Math.PI * 2;
	return a + diff * t;

}

export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 40, window.innerWidth / window.innerHeight, 0.1, 60 );

		// Matches Godot View: 45° azimuth, 35° elevation, distance 16
		this.offset = new THREE.Vector3( 9.27, 9.18, 9.27 );

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		// Camera-aligned ground basis (XZ plane), derived from offset.
		// camRightXZ: screen-right projected to ground.
		// camForwardXZ: screen-up (away from camera) projected to ground.
		this.camRightXZ = new THREE.Vector3( this.offset.z, 0, - this.offset.x ).normalize();
		this.camForwardXZ = new THREE.Vector3( - this.offset.x, 0, - this.offset.z ).normalize();

		this.leadFactor = 3.0;
		this.cameraSmoothing = 2.0;
		this.deadzoneRadius = 5.0;
		this.screenShiftUp = 1.0;

		this.smoothedDesired = new THREE.Vector3();
		this.initialized = false;

		// Follow mode: chase camera that rotates with the vehicle heading
		this.mode = CAMERA_MODE_FIXED;
		this.followDistance = 11.0;
		this.followHeight = 5.5;
		this.followLookHeight = 1.2;
		this.followLookAhead = 2.0;
		this.followYawSmoothing = 5.0;
		this.followPositionSmoothing = 10.0;
		this.followYaw = 0;
		this.followPosition = new THREE.Vector3();
		this.followInitialized = false;

		const segments = 64;
		const points = [];
		for ( let i = 0; i <= segments; i ++ ) {

			const a = ( i / segments ) * Math.PI * 2;
			points.push( new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) ) );

		}
		const dzGeom = new THREE.BufferGeometry().setFromPoints( points );
		this.debug = new THREE.Line( dzGeom, new THREE.LineBasicMaterial( { color: 0xff00ff, depthTest: false } ) );
		this.debug.visible = false;
		this.debug.renderOrder = 999;
		this.debug.quaternion.setFromRotationMatrix(
			new THREE.Matrix4().makeBasis( this.camRightXZ, new THREE.Vector3( 0, 1, 0 ), this.camForwardXZ )
		);

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	setMode( mode ) {

		if ( mode === this.mode ) return;

		this.mode = mode;

		// Each mode snaps into place on entry instead of sweeping across the track.
		this.initialized = false;
		this.followInitialized = false;
		this.debug.visible = this.debug.visible && mode === CAMERA_MODE_FIXED;

	}

	toggleMode() {

		this.setMode( this.mode === CAMERA_MODE_FIXED ? CAMERA_MODE_FOLLOW : CAMERA_MODE_FIXED );
		return this.mode;

	}

	update( dt, target, velocity, heading = 0 ) {

		if ( this.mode === CAMERA_MODE_FOLLOW ) {

			this.updateFollow( dt, target, heading );

		} else {

			this.updateFixed( dt, target, velocity );

		}

	}

	// Chase camera: sits behind the vehicle and rotates with its heading.
	updateFollow( dt, target, heading ) {

		if ( this.followInitialized ) {

			this.followYaw = lerpAngle( this.followYaw, heading, 1 - Math.exp( - dt * this.followYawSmoothing ) );

		} else {

			this.followYaw = heading;

		}

		const sin = Math.sin( this.followYaw );
		const cos = Math.cos( this.followYaw );

		// Ground basis follows the camera so touch steering stays screen-relative.
		this.camForwardXZ.set( sin, 0, cos );
		this.camRightXZ.set( - cos, 0, sin );

		_lookPoint.copy( target )
			.addScaledVector( this.camForwardXZ, this.followLookAhead );
		_lookPoint.y += this.followLookHeight;

		_desired.copy( _lookPoint ).addScaledVector( this.camForwardXZ, - this.followDistance );
		_desired.y = target.y + this.followHeight;

		if ( this.followInitialized ) {

			this.followPosition.lerp( _desired, 1 - Math.exp( - dt * this.followPositionSmoothing ) );

		} else {

			this.followPosition.copy( _desired );
			this.followInitialized = true;

		}

		this.camera.position.copy( this.followPosition );
		this.camera.lookAt( _lookPoint );

		// Keep the fixed-mode target in sync so a switch back starts from the car.
		this.smoothedDesired.copy( target );

	}

	updateFixed( dt, target, velocity ) {

		this.camRightXZ.set( this.offset.z, 0, - this.offset.x ).normalize();
		this.camForwardXZ.set( - this.offset.x, 0, - this.offset.z ).normalize();

		const radius = this.deadzoneRadius;
		const radiusSq = radius * radius;

		// Lead = velocity projected onto camera-aligned ground basis, scaled, clamped to the deadzone disk.
		// Becomes the camera's offset from the car: car settles at the trailing edge of the circle.
		let leadX = velocity.dot( this.camRightXZ ) * this.leadFactor;
		let leadY = velocity.dot( this.camForwardXZ ) * this.leadFactor;
		const leadLenSq = leadX * leadX + leadY * leadY;
		if ( leadLenSq > radiusSq ) {

			const k = radius / Math.sqrt( leadLenSq );
			leadX *= k;
			leadY *= k;

		}

		_desired.copy( target )
			.addScaledVector( this.camRightXZ, leadX )
			.addScaledVector( this.camForwardXZ, leadY );

		const alpha = this.initialized ? 1 - Math.exp( - dt * this.cameraSmoothing ) : 1;
		this.smoothedDesired.lerp( _desired, alpha );
		this.initialized = true;

		// Hard-clamp: car must not escape the deadzone, even if the lerp lags at high speed.
		_delta.subVectors( target, this.smoothedDesired );
		const offsetX = _delta.dot( this.camRightXZ );
		const offsetY = _delta.dot( this.camForwardXZ );
		const offsetLenSq = offsetX * offsetX + offsetY * offsetY;
		if ( offsetLenSq > radiusSq ) {

			const offsetLen = Math.sqrt( offsetLenSq );
			const k = ( offsetLen - radius ) / offsetLen;
			this.smoothedDesired
				.addScaledVector( this.camRightXZ, offsetX * k )
				.addScaledVector( this.camForwardXZ, offsetY * k );

		}

		// Shift the entire view (camera + lookAt) so smoothedDesired sits higher on screen.
		_lookPoint.copy( this.smoothedDesired ).addScaledVector( this.camForwardXZ, - this.screenShiftUp );

		this.camera.position.copy( _lookPoint ).add( this.offset );
		this.camera.lookAt( _lookPoint );

		this.debug.position.copy( this.smoothedDesired );
		this.debug.position.y += 0.05;
		this.debug.scale.set( radius, 1, radius );

	}

}
