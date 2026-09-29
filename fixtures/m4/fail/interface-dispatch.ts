interface Notifier {
  notify(message: string): Promise<unknown>;
}

class SlackNotifier implements Notifier {
  async notify(message: string) {
    return fetch("https://hooks.slack.example/x", { method: "POST", body: message });
  }
}

class LogNotifier implements Notifier {
  async notify(message: string) {
    console.log(message);
  }
}

const smsNotifier: Notifier = {
  notify: (message) => fetch("https://sms.example/send", { method: "POST", body: message }),
};

// A call through an interface could reach any implementation.
/** @perm env(MODE) */
export function alert(n: Notifier) {
  return n.notify("down"); // expect: error PERM001 net(hooks.slack.example) expect: error PERM001 net(sms.example)
}

export const notifiers = [new SlackNotifier(), new LogNotifier(), smsNotifier];
