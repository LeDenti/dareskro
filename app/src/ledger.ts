/**
 * Ledger side: the Device Management Kit (DMK) and the XRP signer.
 *
 * Why a hardware device here, and not a hot key: the human validation IS the
 * product. The employer sees the amount, the destination and the pay date on
 * a screen the agent cannot touch, and nothing moves before that signature.
 *
 * Transports: USB (WebHID) and Bluetooth for a real device, Speculos for the
 * emulator (no device). Chrome, Edge or Brave.
 *
 * Pattern after Ledger's XRPL hackathon workshop (Apache-2.0):
 * github.com/LedgerHQ/device-management-kit-ts-workshop
 */
import {
  DeviceManagementKitBuilder,
  hexaStringToBuffer,
  type DeviceManagementKit,
  type DeviceModelId,
  type DeviceSessionId,
} from "@ledgerhq/device-management-kit";
import { SignerXrpBuilder, type SignerXrp } from "@ledgerhq/device-signer-kit-xrp";
import {
  speculosIdentifier,
  speculosTransportFactory,
} from "@ledgerhq/device-transport-kit-speculos";
import {
  webBleIdentifier,
  webBleTransportFactory,
} from "@ledgerhq/device-transport-kit-web-ble";
import {
  webHidIdentifier,
  webHidTransportFactory,
} from "@ledgerhq/device-transport-kit-web-hid";
import { firstValueFrom } from "rxjs";

export type Transport = "usb" | "ble" | "speculos";

/** First XRP account of the device. Third number for more accounts: 44'/144'/1'/0/0 … */
export const DERIVATION_PATH = "44'/144'/0'/0/0";

const transportIdentifiers: Record<Transport, string> = {
  usb: webHidIdentifier,
  ble: webBleIdentifier,
  speculos: speculosIdentifier,
};

/** Build the DMK once, with every transport the page supports. */
export const createDmk = (speculos: { url: string; model: DeviceModelId }) =>
  new DeviceManagementKitBuilder()
    .addTransport(webHidTransportFactory)
    .addTransport(webBleTransportFactory)
    .addTransport(speculosTransportFactory(speculos.url, false, speculos.model))
    .build();

/** First device found on that transport, then connect. USB/BLE open the browser's picker. */
export async function connect(
  dmk: DeviceManagementKit,
  transport: Transport,
): Promise<DeviceSessionId> {
  const device = await firstValueFrom(
    dmk.startDiscovering({ transport: transportIdentifiers[transport] }),
  );
  return dmk.connect({ device });
}

export const createSigner = (dmk: DeviceManagementKit, sessionId: DeviceSessionId): SignerXrp =>
  new SignerXrpBuilder({ dmk, sessionId }).build();

/** { observable, cancel }: open the XRP app, show the address, done. */
export const getAddress = (signer: SignerXrp, path: string, checkOnDevice: boolean) =>
  signer.getAddress(path, { checkOnDevice });

/** The device shows the fields; the human approves; the output is a DER signature. */
export const signOnDevice = (signer: SignerXrp, path: string, unsignedTxHex: string) =>
  signer.signTransaction(path, hexaStringToBuffer(unsignedTxHex)!);
