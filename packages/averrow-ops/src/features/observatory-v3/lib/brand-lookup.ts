/**
 * The brand filter is a brand ID (`brand=<id>` on /arcs, /stats and /timeline), but the console's search knows brands by
 * NAME (the arcs carry no id). Picking a brand resolves its id with the brands list (`/api/brands?q=`): an exact
 * (case-insensitive) name match wins, else the first hit. Null when nothing matches or the request fails.
 */

import { api } from '@/lib/api';
import { parseBrand } from './url-state';

export interface BrandRef { id: string; name: string }

export async function lookupBrand(name: string): Promise<BrandRef | null> {
  const q = name.trim();
  if (!q) return null;
  try {
    const res = await api.get<Array<{ id: string; name: string }>>(`/api/brands?q=${encodeURIComponent(q)}&limit=10`);
    const rows = (res.success ? res.data : null) ?? [];
    const hit = rows.find(b => b.name?.toLowerCase() === q.toLowerCase()) ?? rows[0];
    return hit && parseBrand(hit.id) ? { id: hit.id, name: hit.name || q } : null;
  } catch {
    return null;
  }
}
