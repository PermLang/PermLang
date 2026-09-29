// Minimal stand-in for axios's types (shape verified against axios's index.d.ts).
declare module "axios" {
  export class Axios {
    request(config: object): Promise<unknown>;
    get(url: string, config?: object): Promise<unknown>;
    post(url: string, data?: unknown, config?: object): Promise<unknown>;
  }
  export interface AxiosInstance extends Axios {
    (config: object): Promise<unknown>;
    (url: string, config?: object): Promise<unknown>;
  }
  export interface AxiosStatic extends AxiosInstance {
    create(config?: object): AxiosInstance;
  }
  const axios: AxiosStatic;
  export default axios;
}
