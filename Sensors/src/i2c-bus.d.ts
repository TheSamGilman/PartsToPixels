declare module "i2c-bus" {
  export interface PromisifiedBus {
    close(): Promise<void>;
    i2cRead(addr: number, length: number, buffer: Buffer): Promise<{ bytesRead: number; buffer: Buffer }>;
    i2cWrite(addr: number, length: number, buffer: Buffer): Promise<{ bytesWritten: number; buffer: Buffer }>;
  }

  function openPromisified(busNumber: number): Promise<PromisifiedBus>;

  const _default: { openPromisified: typeof openPromisified };
  export default _default;
  export { openPromisified };
}
