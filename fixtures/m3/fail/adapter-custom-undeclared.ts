import { sendSms } from "@acme/sms";

/** @perm sms.send(+15550100) */
export function page(to: string) {
  sendSms("+15550199", "hi"); // expect: error PERM001 sms.send(+15550199)
  sendSms(to, "hi"); // expect: error PERM001 sms.send
}
