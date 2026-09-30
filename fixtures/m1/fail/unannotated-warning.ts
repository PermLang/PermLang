// An exported function without @perm fails at the default level, development (M5).
export async function getWeather() {
  return fetch("https://api.weather.example/today"); // expect: error PERM003 net(api.weather.example)
}
