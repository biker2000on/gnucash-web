export interface ProductIdentity {
  readonly name: 'Folio';
  /** Sub-line under the wordmark; empty = wordmark only. */
  readonly descriptor: '';
  readonly brand: 'Folio';
  readonly shortName: 'Folio';
  readonly description: 'A self-hosted personal and small-business finance platform.';
}

export const product: Readonly<ProductIdentity> = Object.freeze<ProductIdentity>({
  name: 'Folio',
  descriptor: '',
  brand: 'Folio',
  shortName: 'Folio',
  description: 'A self-hosted personal and small-business finance platform.',
});
