export interface ProductIdentity {
  readonly name: 'Folio';
  readonly descriptor: 'for GnuCash';
  readonly brand: 'Folio for GnuCash';
  readonly shortName: 'Folio';
  readonly description: 'A self-hosted, GnuCash-compatible personal finance platform.';
}

export const product: Readonly<ProductIdentity> = Object.freeze<ProductIdentity>({
  name: 'Folio',
  descriptor: 'for GnuCash',
  brand: 'Folio for GnuCash',
  shortName: 'Folio',
  description: 'A self-hosted, GnuCash-compatible personal finance platform.',
});
