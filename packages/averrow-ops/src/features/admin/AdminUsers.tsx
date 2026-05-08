import { Card } from '@/components/ui/Card';
import { SectionLabel } from '@/components/ui/SectionLabel';

export function AdminUsers() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold font-display" style={{ color: 'var(--text-primary)' }}>Users</h1>
        <p className="text-sm font-mono mt-1" style={{ color: 'var(--text-secondary)' }}>User management</p>
      </div>

      <Card hover={false}>
        <SectionLabel className="mb-2">Active Users</SectionLabel>
        <div className="text-2xl font-bold font-display" style={{ color: 'var(--text-primary)' }}>1</div>
        <p className="text-xs text-white/55 mt-1">Administrator</p>
      </Card>

      <Card hover={false}>
        <SectionLabel className="mb-3">Multi-tenant Access</SectionLabel>
        <p className="text-sm text-white/55">
          Team management and role-based access control coming in Phase F.
        </p>
      </Card>
    </div>
  );
}
