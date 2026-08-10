-- ============================================================================
-- AUTOMATED CONTRACT/COMPLIANCE-EXPIRY REMINDERS
-- ============================================================================
-- Upgrades the existing Contract Expiry Tracker (analyzeContractExpiry,
-- purely a passive dashboard a supervisor has to remember to check) into
-- something that proactively notifies -- both the employee ("your contract
-- period is ending soon, talk to your supervisor") and confirms to the
-- supervisor that the reminder went out. Deduplicated per urgency tier via
-- a tracking column so re-visiting the page doesn't re-notify every time,
-- only when the situation has genuinely escalated (e.g. warning -> urgent).

alter table public.profiles add column if not exists contract_expiry_notified_tier text;

create or replace function public.send_contract_expiry_reminder(p_employee_id uuid, p_tier text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_tier text;
  v_employee_name text;
begin
  if not public.is_supervisor() then
    raise exception 'Only supervisors can send contract expiry reminders';
  end if;

  select contract_expiry_notified_tier, name into v_current_tier, v_employee_name
  from public.profiles where id = p_employee_id;

  if v_current_tier is not distinct from p_tier then
    return false; -- already reminded at this exact tier -- no-op, not an error
  end if;

  update public.profiles set contract_expiry_notified_tier = p_tier where id = p_employee_id;

  perform public.notify(p_employee_id, format('Your contract/internship period is %s — please check in with your supervisor.', p_tier));
  perform public.notify(auth.uid(), format('Contract expiry reminder sent to %s (%s).', coalesce(v_employee_name, 'employee'), p_tier));

  return true;
end;
$$;

grant execute on function public.send_contract_expiry_reminder(uuid, text) to authenticated;
