export type VehicleStatus = "active" | "for_sale" | "stored" | "damaged" | "sold";

export interface Vehicle {
  plate: string;
  name: string | null;
  company: string | null;
  department: number | null;
  model: string | null;
  status: VehicleStatus;
  note: string | null;
  tank_liters: number | null;
  fuel_level_unit: "l" | "%";
  fuel_type: string | null;
  norm_l_100km: number | null;
  lukoil_card: string | null;
  has_gps: boolean;
  active: boolean;
  in_allocation: boolean;
}

export interface Refuel {
  id: number;
  ts: string;
  plate: string | null;
  plate_raw: string | null;
  card: string | null;
  fuel_category: string | null;
  product: string | null;
  liters: number;
  unit_price: number | null;
  amount: number | null;
  station: string | null;
  company: string | null;
  source: string | null;
  source_file: string | null;
}

export interface UnmatchedRow {
  plate: string | null;
  plate_raw: string | null;
  company: string | null;
  month: string;
  rows: number;
  liters: number;
  amount: number | null;
}

export interface FetchLog {
  id: number;
  run_at: string;
  snap_date: string | null;
  status: string | null;
  vehicles_count: number | null;
  message: string | null;
  triggered_by: string | null;
}

export const STATUS_LABEL: Record<VehicleStatus, string> = {
  active: "активна",
  for_sale: "за продажба",
  stored: "на съхранение",
  damaged: "аварирала",
  sold: "продадена",
};
