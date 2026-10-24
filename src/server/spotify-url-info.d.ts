declare module "spotify-url-info" {
  const client: (
    fetch: (url: string, options?: RequestInit) => Promise<Response>,
  ) => { getData(url: string): Promise<unknown> };
  export default client;
}
