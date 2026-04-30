// Audit logging helper.
// Fire-and-forget: never throws into the caller's path.

import { directPost } from '../supabaseClient.js';

/**
 * Log an action to the audit_log table.
 * @param {object} me  — current employee record (must have id, name, auth_user_id)
 * @param {string} action — slug like 'sign_in', 'request_approve', 'leave_decide'
 * @param {object} opts — { targetType, targetId, targetLabel, details }
 */
export async function logAction(me, action, opts = {}) {
  if (!me) return;
  try {
    // directPost (raw fetch + timeout) instead of supabase.from().insert():
    // the lazy supabase-js builder wedges silently on some sessions, and
    // because this function's catch block is silent, every wedged insert
    // resulted in zero rows ever landing in audit_log. directPost fails
    // loudly to the console instead of hanging forever.
    await directPost('audit_log', {
      actor_user_id: me.auth_user_id || null,
      actor_psn:     me.id,
      actor_name:    me.name,
      action,
      target_type:   opts.targetType  || null,
      target_id:     opts.targetId    ? String(opts.targetId) : null,
      target_label:  opts.targetLabel || null,
      details:       opts.details     || null,
      user_agent:    typeof navigator !== 'undefined' ? navigator.userAgent : null,
    }, { timeoutMs: 6000 });
  } catch (err) {
    // Still don't disrupt the user, but log loudly so future debugging is easy.
    if (typeof console !== 'undefined') console.warn('audit log failed:', err?.message || err);
  }
}

// Friendly labels for the action slugs (used by the admin panel)
export const ACTION_LABELS = {
  sign_in:                 'Signed in',
  sign_out:                'Signed out',
  request_approve:         'Approved registration',
  request_reject:          'Rejected registration',
  leave_request_create:    'Created leave request',
  leave_request_decide:    'Decided leave request',
  leave_request_delete:    'Deleted leave request',
  leave_type_update:       'Updated leave type',
  employee_update:         'Updated employee',
};

export function formatAction(slug) {
  return ACTION_LABELS[slug] || slug.replace(/_/g, ' ');
}
