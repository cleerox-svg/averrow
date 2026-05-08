import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { useInviteMember } from '@/hooks/useOrganization';

interface MemberInviteSheetProps {
  open: boolean;
  onClose: () => void;
}

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'analyst', label: 'Analyst' },
  { value: 'admin', label: 'Admin' },
];

export function MemberInviteSheet({ open, onClose }: MemberInviteSheetProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('analyst');
  const invite = useInviteMember();

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await invite.mutateAsync({ email: email.trim(), org_role: role });
    setEmail('');
    setRole('analyst');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-instrument border border-white/10 rounded-t-2xl sm:rounded-xl p-6 space-y-4">
        <div className="font-mono text-xs font-bold text-accent uppercase tracking-wider">Invite Member</div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Email address
            </label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@company.com"
              className="w-full"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Role
            </label>
            <Select
              options={ROLE_OPTIONS}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              className="w-full"
            />
            <div className="mt-2 text-[10px] text-white/55 space-y-0.5">
              <div><span className="text-[color:var(--text-secondary)]">Owner</span> — Full access, billing, delete org</div>
              <div><span className="text-[color:var(--text-secondary)]">Admin</span> — Manage members, configure integrations</div>
              <div><span className="text-[color:var(--text-secondary)]">Analyst</span> — View all data, manage takedowns/alerts</div>
              <div><span className="text-[color:var(--text-secondary)]">Viewer</span> — Read-only access to brands and threats</div>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="secondary" size="md" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" size="md" disabled={invite.isPending || !email.trim()} className="flex-1">
              {invite.isPending ? 'Sending...' : 'Send Invitation'}
            </Button>
          </div>
          {invite.isError && (
            <p className="text-[11px] text-accent">Failed to send invitation. Please try again.</p>
          )}
        </form>
      </div>
    </div>
  );
}
