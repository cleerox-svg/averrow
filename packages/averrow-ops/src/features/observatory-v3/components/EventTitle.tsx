/** An event sentence with its leading entity name (the brand / operation / domain it is about) set bold. */

import { splitLeadEntity } from '../lib/events';

export function EventTitle({ title, name }: { title: string; name?: string | null }) {
  const [lead, rest] = splitLeadEntity(title, name);
  if (!lead) return <>{title}</>;
  return (
    <>
      <strong className="font-semibold" style={{ color: 'var(--text-primary)' }}>{lead}</strong>
      <span style={{ color: 'var(--text-secondary)' }}>{rest}</span>
    </>
  );
}
