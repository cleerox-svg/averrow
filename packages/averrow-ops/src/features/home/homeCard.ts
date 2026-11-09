// Overview cards are flat under the facelift; FACELIFT=false keeps the legacy
// glass card. (FACELIFT is also what sets data-accent, which scopes home.css.)
import { FACELIFT } from '@averrow/shared/theme';

export const HOME_CARD_VARIANT: 'flat' | 'base' = FACELIFT ? 'flat' : 'base';
