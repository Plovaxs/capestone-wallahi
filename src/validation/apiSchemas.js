import { z } from 'zod';

// `.passthrough()` deliberately allows unknown extra fields through — this
// isn't meant to be an exhaustive contract, just a way to catch the loud
// failure mode (a renamed/removed column silently making a core field
// `undefined` everywhere it's used) early and legibly during development.
const looseObject = (shape) => z.object(shape).passthrough();

const profileShape = looseObject({
    id: z.string(),
    name: z.string(),
    role: z.string(),
});

const taskShape = looseObject({
    id: z.union([z.string(), z.number()]),
    title: z.string(),
    status: z.string(),
});

const attendanceShape = looseObject({
    id: z.union([z.string(), z.number()]),
    employee_id: z.string(),
    date: z.string(),
});

const leaveRequestShape = looseObject({
    id: z.union([z.string(), z.number()]),
    employee_id: z.string(),
    status: z.string(),
});

/** Keyed by the same `label` every repository call already passes to runQuery/runMutation. */
export const apiSchemas = {
    'profiles.getById': profileShape.nullable(),
    'profiles.listAll': z.array(profileShape),
    'tasks.listAll': z.array(taskShape),
    'attendance.listAll': z.array(attendanceShape),
    'leave.listAll': z.array(leaveRequestShape),
};
