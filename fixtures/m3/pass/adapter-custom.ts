import { sendSms } from "@acme/sms";

/** @perm sms.send(+15550100) */
export function pageOnCall() {
  return sendSms("+15550100", "Checkout is down");
}
