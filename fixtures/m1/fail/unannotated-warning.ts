// Functions without @perm are reported but not failed in M1 (strictness levels come later).
export async function getWeather() {
  return fetch("https://api.weather.example/today"); // expect: warning PERM003 net(api.weather.example)
}
