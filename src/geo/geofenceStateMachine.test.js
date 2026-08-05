import { describe, it, expect } from 'vitest';
import { createGeofenceStateMachine } from './geofenceStateMachine';

describe('createGeofenceStateMachine', () => {
    it('starts UNKNOWN and resolves immediately on the first reading via the plain radius check', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 2 });
        expect(machine.getState()).toBe('UNKNOWN');
        const result = machine.update(50);
        expect(result).toEqual({ state: 'INSIDE', changed: true });
    });

    it('requires consecutive confirming reads before committing a state change', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 3 });
        machine.update(50); // establishes INSIDE
        expect(machine.getState()).toBe('INSIDE');

        expect(machine.update(200).changed).toBe(false); // 1st OUTSIDE reading
        expect(machine.getState()).toBe('INSIDE');
        expect(machine.update(200).changed).toBe(false); // 2nd
        expect(machine.getState()).toBe('INSIDE');
        expect(machine.update(200)).toEqual({ state: 'OUTSIDE', changed: true }); // 3rd commits
    });

    it('does not flicker on noise within the hysteresis band once a state is established', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 2 });
        machine.update(50); // INSIDE
        // Jitters between 90 and 110 — all inside the [85, 115] hysteresis band — should hold INSIDE the whole time.
        for (const d of [90, 110, 95, 105, 88, 112]) {
            const result = machine.update(d);
            expect(result.state).toBe('INSIDE');
            expect(result.changed).toBe(false);
        }
    });

    it('a single noisy sample past the hysteresis band does not immediately flip state', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 2 });
        machine.update(50); // INSIDE
        const result = machine.update(200); // one bad reading, way outside
        expect(result.changed).toBe(false);
        expect(machine.getState()).toBe('INSIDE');
    });

    it('resets the pending counter if confirming readings are not consecutive', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 2 });
        machine.update(50); // INSIDE
        machine.update(200); // 1st OUTSIDE candidate
        machine.update(50); // back INSIDE — resets the OUTSIDE streak
        expect(machine.update(200).changed).toBe(false); // only the 1st OUTSIDE candidate again
        expect(machine.getState()).toBe('INSIDE');
    });

    it('re-enters as soon as a reading is back within the full configured radius (no entry shrinkage)', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 1 });
        machine.update(50); // INSIDE
        machine.update(200); // OUTSIDE
        expect(machine.getState()).toBe('OUTSIDE');
        // 110 is within the exit hysteresis band (100-115) but still outside the
        // radius itself, and state is OUTSIDE, so it should hold OUTSIDE.
        expect(machine.update(110)).toEqual({ state: 'OUTSIDE', changed: false });
        // Any reading at or inside the FULL configured radius (100m) commits
        // INSIDE -- the entry side must never require less than the radius an
        // admin actually configured.
        expect(machine.update(95)).toEqual({ state: 'INSIDE', changed: true });
    });

    it('does not require re-crossing the radius twice: exiting only needs to clear radius + hysteresis', () => {
        const machine = createGeofenceStateMachine({ radiusMeters: 100, hysteresisMeters: 15, requiredConsecutiveReads: 1 });
        machine.update(50); // INSIDE
        // 110 is past the radius but still inside the exit hysteresis band (<=115) -- holds INSIDE.
        expect(machine.update(110)).toEqual({ state: 'INSIDE', changed: false });
        // 116 clears the exit threshold (100 + 15) -- now it commits OUTSIDE.
        expect(machine.update(116)).toEqual({ state: 'OUTSIDE', changed: true });
    });
});
