/** Vehicle properties a truck route depends on. Absent fields are unknown. */
export type TruckProfile = {
  maxPermMassT?: number;
  massT?: number;
  axleLoadT?: number;
  heightM?: number;
  widthM?: number;
  lengthM?: number;
  passIds?: number[];
};

/** A profile is complete when permitted mass and all three dimensions are known. */
export function isTruckProfileComplete(p: TruckProfile | null | undefined): boolean {
  return !!p && p.maxPermMassT != null && p.heightM != null && p.widthM != null && p.lengthM != null;
}
