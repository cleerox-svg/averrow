import { useState } from 'react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { useCreateApiKey } from '@/hooks/useOrganization';

interface ApiKeyCreateSheetProps {
  open: boolean;
  onClose: () => void;
}

const ALL_SCOPES = [
  { key: 'threats:read', label: 'Read threat intelligence' },
  { key: 'threats:write', label: 'Create/update threats' },
  { key: 'brands:read', label: 'Read brand data' },
  { key: 'brands:write', label: 'Create/update brands' },
  { key: 'takedowns:read', label: 'Read takedown requests' },
  { key: 'takedowns:write', label: 'Submit takedowns' },
  { key: 'reports:read', label: 'Read reports and briefings' },
];

const EXPIRY_OPTIONS = [
  { label: 'Never', value: '' },
  { label: '30 days', value: '30' },
  { label: '90 days', value: '90' },
  { label: '1 year', value: '365' },
];

export function ApiKeyCreateSheet({ open, onClose }: ApiKeyCreateSheetProps) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['threats:read', 'brands:read', 'takedowns:read', 'reports:read']);
  const [expiry, setExpiry] = useState('');
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useCreateApiKey();

  if (!open) return null;

  const toggleScope = (scope: string) => {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    let expiresAt: string | undefined;
    if (expiry) {
      const d = new Date();
      d.setDate(d.getDate() + parseInt(expiry, 10));
      expiresAt = d.toISOString();
    }
    const result = await create.mutateAsync({ name: name.trim(), scopes, expires_at: expiresAt });
    if (result.data?.key) {
      setRevealedKey(result.data.key);
    }
  };

  const handleCopy = async () => {
    if (!revealedKey) return;
    await navigator.clipboard.writeText(revealedKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDone = () => {
    setName('');
    setScopes(['threats:read', 'brands:read', 'takedowns:read', 'reports:read']);
    setExpiry('');
    setRevealedKey(null);
    setCopied(false);
    onClose();
  };

  // Key reveal view (shown once after generation)
  if (revealedKey) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div className="fixed inset-0 bg-black/60" />
        <div className="relative w-full sm:max-w-md bg-instrument border border-warning/30 rounded-t-2xl sm:rounded-xl p-6 space-y-4">
          <div className="font-mono text-xs font-bold text-warning uppercase tracking-wider">
            Copy your API key now
          </div>
          <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
            This key will not be shown again. Store it securely.
          </p>
          <div className="border border-white/10 rounded-lg p-3 font-mono text-xs break-all select-all" style={{ background: 'var(--bg-page)', color: 'var(--text-primary)' }}>
            {revealedKey}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="md" onClick={handleCopy} className="flex-1">
              {copied ? 'Copied!' : 'Copy to Clipboard'}
            </Button>
            <Button size="md" onClick={handleDone} className="flex-1">
              Done
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="fixed inset-0 bg-black/60" onClick={onClose} />
      <div className="relative w-full sm:max-w-md bg-instrument border border-white/10 rounded-t-2xl sm:rounded-xl p-6 space-y-4 max-h-[80vh] overflow-y-auto">
        <div className="font-mono text-xs font-bold text-accent uppercase tracking-wider">Create API Key</div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-1">
              Key Name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production API Key"
              className="w-full"
              required
            />
          </div>

          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-2">
              Permissions
            </label>
            <div className="space-y-2">
              {ALL_SCOPES.map((s) => (
                <label key={s.key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={scopes.includes(s.key)}
                    onChange={() => toggleScope(s.key)}
                    className="w-3.5 h-3.5 rounded border-white/20 accent-[color:var(--amber)]"
                    style={{ background: 'var(--bg-page)' }}
                  />
                  <span className="text-[11px]" style={{ color: 'var(--text-primary)' }}>
                    <span className="font-mono text-[color:var(--text-secondary)]">{s.key}</span> — {s.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-[color:var(--text-secondary)] font-mono uppercase tracking-wide mb-2">
              Expiry
            </label>
            <div className="flex gap-2 flex-wrap">
              {EXPIRY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setExpiry(opt.value)}
                  className={`px-3 py-1 rounded-md text-[11px] font-mono border transition-colors ${
                    expiry === opt.value
                      ? 'border-accent/30 bg-accent/10 text-accent'
                      : 'border-white/10 text-[color:var(--text-tertiary)] hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="secondary" size="md" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" size="md" disabled={create.isPending || !name.trim()} className="flex-1">
              {create.isPending ? 'Generating...' : 'Generate Key'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
