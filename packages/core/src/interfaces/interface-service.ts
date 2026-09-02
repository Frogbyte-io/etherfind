import type { NetworkInterfaceInfo } from "../models/interface.js";

/** Port: enumerates network interfaces with normalized metadata. */
export interface InterfaceService {
  enumerate(): Promise<NetworkInterfaceInfo[]>;
}
