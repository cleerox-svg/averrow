// Product name used in account-page copy ("Install Averrow", "Shown across
// Averrow"). Averrow is the default, so Averrow's output is unchanged; a
// vendoring product (FarmTrack) wraps its account routes once:
//   <ProductNameProvider name="FarmTrack">...</ProductNameProvider>
// Context only (no per-page prop): the name is app-wide, and a prop would have
// to be threaded through every section.

import { createContext, useContext, type ReactNode } from 'react';

export const DEFAULT_PRODUCT_NAME = 'Averrow';

const ProductNameContext = createContext<string>(DEFAULT_PRODUCT_NAME);

export function ProductNameProvider({ name, children }: { name: string; children: ReactNode }) {
  return <ProductNameContext.Provider value={name}>{children}</ProductNameContext.Provider>;
}

/** The product's display name for user-facing copy. */
export function useProductName(): string {
  return useContext(ProductNameContext);
}
