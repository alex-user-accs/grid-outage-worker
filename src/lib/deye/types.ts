import { z } from "zod";

// Schemas follow Deye's Swagger spec (docs/deye-openapi.json). They are lenient
// (loose objects, nullable numbers) because Deye omits fields per device model.

const num = z.number().nullish();

export const baseResponse = z.looseObject({
  code: z.union([z.string(), z.number()]).transform(String).optional(),
  msg: z.string().nullish(),
  success: z.boolean().optional(),
  requestId: z.string().nullish(),
});
export type BaseResponse = z.infer<typeof baseResponse>;

export const tokenResponse = baseResponse.extend({
  accessToken: z.string(),
  expiresIn: z.union([z.string(), z.number()]).transform(Number),
  refreshToken: z.string().nullish(),
  uid: z.number().nullish(),
});

export const station = z.looseObject({
  id: z.number(),
  name: z.string().nullish(),
  installedCapacity: num,
  generationPower: num,
  batterySOC: num,
  connectionStatus: z.string().nullish(),
  regionTimezone: z.string().nullish(),
  startOperatingTime: z.union([z.string(), z.number()]).nullish(),
  lastUpdateTime: z.union([z.string(), z.number()]).nullish(),
  locationAddress: z.string().nullish(),
  locationLat: num,
  locationLng: num,
  ownerName: z.string().nullish(),
  contactPhone: z.string().nullish(),
});
export type Station = z.infer<typeof station>;

export const stationListResponse = baseResponse.extend({
  stationList: z.array(station).nullish().transform((v) => v ?? []),
  total: num,
});

export const stationLatest = baseResponse.extend({
  generationPower: num,
  consumptionPower: num,
  gridPower: num,
  purchasePower: num,
  wirePower: num,
  chargePower: num,
  dischargePower: num,
  batteryPower: num,
  batterySOC: num,
  irradiateIntensity: num,
  lastUpdateTime: z.union([z.string(), z.number()]).nullish(),
});
export type StationLatest = z.infer<typeof stationLatest>;

export const stationDataItem = z.looseObject({
  generationPower: num,
  consumptionPower: num,
  gridPower: num,
  purchasePower: num,
  wirePower: num,
  chargePower: num,
  dischargePower: num,
  batteryPower: num,
  batterySOC: num,
  generationValue: num,
  consumptionValue: num,
  gridValue: num,
  purchaseValue: num,
  chargeValue: num,
  dischargeValue: num,
  timeStamp: z.union([z.string(), z.number()]).nullish(),
  year: num,
  month: num,
  day: num,
});
export type StationDataItem = z.infer<typeof stationDataItem>;

export const stationHistoryResponse = baseResponse.extend({
  stationDataItems: z.array(stationDataItem).nullish().transform((v) => v ?? []),
  total: num,
});

export const stationDevice = z.looseObject({
  deviceSn: z.string(),
  deviceId: num,
  deviceType: z.string().nullish(),
  stationId: num,
  productId: z.string().nullish(),
  connectStatus: num, // 0 offline, 1 online, 2 alert
  collectionTime: num,
});
export type StationDevice = z.infer<typeof stationDevice>;

export const stationDeviceResponse = baseResponse.extend({
  deviceListItems: z.array(stationDevice).nullish().transform((v) => v ?? []),
  total: num,
});

export const deviceLatestItem = z.looseObject({
  deviceSn: z.string(),
  deviceType: z.string().nullish(),
  deviceState: num, // 1 online, 2 alert, 3 offline
  collectionTime: num,
  dataList: z
    .array(z.looseObject({ key: z.string(), value: z.union([z.string(), z.number()]).nullish(), unit: z.string().nullish() }))
    .nullish()
    .transform((v) => v ?? []),
});
export type DeviceLatestItem = z.infer<typeof deviceLatestItem>;

export const deviceLatestResponse = baseResponse.extend({
  deviceDataList: z.array(deviceLatestItem).nullish().transform((v) => v ?? []),
});

export const stationAlert = z.looseObject({
  alertId: z.union([z.string(), z.number()]).transform(String),
  alertName: z.string().nullish(),
  alertCode: z.string().nullish(),
  protocolName: z.string().nullish(),
  deviceSn: z.string().nullish(),
  deviceType: z.string().nullish(),
  level: num, // 0 notice, 1 warning, 2 failure
  impact: num, // 0 none, 1 production, 2 safety, 3 both
  status: num, // 1 open, 0 closed
  alertStartTime: num,
  alertEndTime: num,
});
export type StationAlert = z.infer<typeof stationAlert>;

export const stationAlertResponse = baseResponse.extend({
  stationAlertItems: z.array(stationAlert).nullish().transform((v) => v ?? []),
  total: num,
});

/** granularity: 1 = intraday frames, 2 = days, 3 = months, 4 = years */
export type Granularity = 1 | 2 | 3 | 4;

/** The read-only subset of the Deye OpenAPI this app uses. Implemented by the real and the mock client. */
export interface DeyeApi {
  stationList(): Promise<Station[]>;
  stationLatest(stationId: number): Promise<StationLatest>;
  stationHistory(stationId: number, granularity: Granularity, startAt: string, endAt?: string): Promise<StationDataItem[]>;
  stationDevices(stationId: number): Promise<StationDevice[]>;
  deviceLatest(deviceSns: string[]): Promise<DeviceLatestItem[]>;
  stationAlerts(stationId: number, startTs: number, endTs: number): Promise<StationAlert[]>;
}
