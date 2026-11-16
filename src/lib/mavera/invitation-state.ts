export type InvitationState = 'pending' | 'expired' | 'accepted' | 'revoked';
export function invitationState(invitation: { accepted_at: string | null; revoked_at: string | null; expires_at: string }, now = Date.now()): InvitationState {
  if (invitation.revoked_at) return 'revoked';
  if (invitation.accepted_at) return 'accepted';
  return new Date(invitation.expires_at).getTime() <= now ? 'expired' : 'pending';
}