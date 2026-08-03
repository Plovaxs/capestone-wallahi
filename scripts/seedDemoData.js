// Demo data seeder for presentations/grading — populates realistic-looking
// records so the app doesn't look empty when demoed. The demo employee
// *accounts* are safe to re-run (upserted by id, tagged with a "+demo" email
// alias); their tasks/leave/attendance/evaluations/forum posts are plain
// inserts, so re-running the script duplicates those — run it once per
// fresh demo dataset, not repeatedly against the same project.
//
// Requires the Supabase SERVICE ROLE key (never the anon key — this script
// creates auth users and bypasses RLS by design). Add it to your local
// (gitignored) .env as SUPABASE_SERVICE_ROLE_KEY=..., or pass it inline —
// never commit it:
//
//   npm run seed:demo
//   # or: SUPABASE_SERVICE_ROLE_KEY=... VITE_SUPABASE_URL=... node scripts/seedDemoData.js
//
// To remove all demo data later, delete every auth user whose email
// contains "+demo@" from the Supabase dashboard (Authentication > Users) —
// the profiles/tasks/leave_requests/etc. rows cascade-delete with them.

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
    console.error('Usage: SUPABASE_SERVICE_ROLE_KEY=... VITE_SUPABASE_URL=... node scripts/seedDemoData.js');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
});

const DEMO_EMPLOYEES = [
    { name: 'Aditya Pratama', initials: 'AP', department: 'IT Division', source: 'President University', work_mode: 'WFO' },
    { name: 'Sarah Wijaya', initials: 'SW', department: 'Customs Ops', source: 'Bina Nusantara', work_mode: 'WFH' },
    { name: 'Michael Tanaka', initials: 'MT', department: 'IT Division', source: 'Universitas Indonesia', work_mode: 'WFO' },
    { name: 'Putri Anjani', initials: 'PA', department: 'Compliance', source: 'President University', work_mode: 'WFO' },
    { name: 'Rizky Firmansyah', initials: 'RF', department: 'Customs Ops', source: 'Telkom University', work_mode: 'WFH' },
];

const todayStr = (offsetDays = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().split('T')[0];
};

async function ensureSupervisor() {
    const { data, error } = await supabase.from('profiles').select('id, name').eq('role', 'supervisor').limit(1);
    if (error) throw error;
    if (!data || data.length === 0) {
        throw new Error('No supervisor account found. Register at least one supervisor in the app first, then re-run this script.');
    }
    return data[0];
}

async function upsertDemoEmployee(spec) {
    const email = `${spec.initials.toLowerCase()}+demo@example.com`;
    const password = 'DemoPass123!';

    const { data: existing } = await supabase.auth.admin.listUsers();
    let userId = existing?.users?.find((u) => u.email === email)?.id;

    if (!userId) {
        const { data: created, error: createError } = await supabase.auth.admin.createUser({
            email,
            password,
            email_confirm: true,
            user_metadata: { name: spec.name, initials: spec.initials },
        });
        if (createError) throw createError;
        userId = created.user.id;
    }

    const contractStart = todayStr(-30);
    const contractEnd = todayStr(150);

    const { error: profileError } = await supabase.from('profiles').upsert(
        {
            id: userId,
            name: spec.name,
            email,
            role: 'employee',
            initials: spec.initials,
            department: spec.department,
            source: spec.source,
            work_mode: spec.work_mode,
            vacation_days: 12,
            sick_days: 6,
            contract_start_date: contractStart,
            contract_end_date: contractEnd,
        },
        { onConflict: 'id' }
    );
    if (profileError) throw profileError;

    return { id: userId, ...spec };
}

async function seedAttendance(employee) {
    const rows = [];
    for (let i = 1; i <= 10; i++) {
        if (i % 6 === 0) continue; // skip a day here and there, like a real roster
        const late = i % 4 === 0;
        rows.push({
            employee_id: employee.id,
            date: todayStr(-i),
            status: late ? 'Late' : 'Present',
            clock_in: late ? '08:24:00' : '07:52:00',
            clock_out: '17:05:00',
        });
    }
    const { error } = await supabase.from('attendance').insert(rows);
    if (error) console.warn(`attendance seed warning for ${employee.name}:`, error.message);
}

async function seedTasks(employee) {
    const templates = [
        { title: 'Review SOP compliance checklist', priority: 'High', status: 'To Do', dueOffset: 5 },
        { title: 'Draft weekly import/export summary', priority: 'Normal', status: 'In Progress', dueOffset: 2 },
        { title: 'Update customs declaration template', priority: 'Normal', status: 'Completed', dueOffset: -1 },
        { title: 'Audit Q1 shipment records', priority: 'High', status: 'Approved', dueOffset: -6 },
    ];
    const rows = templates.map((t) => ({
        title: t.title,
        description: `Demo task auto-generated for ${employee.name}.`,
        assigned_to: [employee.id],
        due_date: todayStr(t.dueOffset),
        priority: t.priority,
        status: t.status,
        is_extended: false,
    }));
    const { error } = await supabase.from('tasks').insert(rows);
    if (error) console.warn(`tasks seed warning for ${employee.name}:`, error.message);
}

async function seedLeaveRequest(employee) {
    const { error } = await supabase.from('leave_requests').insert({
        employee_id: employee.id,
        type: 'Paid Holiday',
        start_date: todayStr(10),
        end_date: todayStr(12),
        reason: 'Family event',
        status: 'Pending',
    });
    if (error) console.warn(`leave seed warning for ${employee.name}:`, error.message);
}

async function seedEvaluation(employee, supervisor) {
    const scores = {};
    ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'D1', 'D2', 'D3', 'D4', 'D5']
        .forEach((id) => { scores[id] = 2 + (Math.random() > 0.6 ? 1 : 0); });
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    const finalScore = parseFloat(((total / (26 * 3)) * 100).toFixed(2));

    const { error } = await supabase.from('performance_evaluations').insert({
        employee_id: employee.id,
        supervisor_id: supervisor.id,
        scores,
        final_score: finalScore,
        comments: 'Consistently reliable, good communication with the team. Demo-seeded record.',
    });
    if (error) console.warn(`evaluation seed warning for ${employee.name}:`, error.message);
}

async function seedContribution(employee) {
    const { error } = await supabase.from('contributions').insert({
        employee_id: employee.id,
        date: todayStr(-2),
        contribution: `Shared a quick update on the ${employee.department} workflow — demo forum post for ${employee.name}.`,
        category: 'General Discussion',
    });
    if (error) console.warn(`contribution seed warning for ${employee.name}:`, error.message);
}

async function main() {
    console.log('Looking up an existing supervisor account...');
    const supervisor = await ensureSupervisor();
    console.log(`Using supervisor: ${supervisor.name}`);

    for (const spec of DEMO_EMPLOYEES) {
        console.log(`Seeding ${spec.name}...`);
        const employee = await upsertDemoEmployee(spec);
        await seedAttendance(employee);
        await seedTasks(employee);
        await seedLeaveRequest(employee);
        await seedEvaluation(employee, supervisor);
        await seedContribution(employee);
    }

    console.log('\nDone. Demo accounts (password: DemoPass123!):');
    DEMO_EMPLOYEES.forEach((e) => console.log(`  - ${e.initials.toLowerCase()}+demo@example.com  (${e.name})`));
}

main().catch((err) => {
    console.error('Seed script failed:', err.message);
    process.exit(1);
});
