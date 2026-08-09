-- Adds the two fields the Outsource Directory dashboard table (supervisor
-- view) needs that profiles didn't already carry: a job title/position
-- ("Backend Developer Intern") separate from the system `role`
-- (employee/supervisor), and a free-text job description. `department`,
-- `source` (institution), and the two contract dates already existed.
alter table profiles
    add column if not exists position text,
    add column if not exists job_desk text;

comment on column profiles.position is 'Job title / position shown on the outsource directory (e.g. "Backend Developer Intern") -- distinct from the system role (employee/supervisor).';
comment on column profiles.job_desk is 'Free-text job description / responsibilities shown on the outsource directory.';
