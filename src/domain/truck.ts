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
