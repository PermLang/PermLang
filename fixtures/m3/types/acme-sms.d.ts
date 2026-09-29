// A team's internal package, covered by a team-written adapter (adapters/acme-sms.json).
declare module "@acme/sms" {
  export function sendSms(to: string, body: string): Promise<void>;
}
