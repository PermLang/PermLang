// Minimal stand-in for stripe v22's types (class names verified against stripe@22.6.2).
declare module "stripe" {
  class StripeResource {}
  class RefundResource extends StripeResource {
    create(params?: object): Promise<unknown>;
    retrieve(id: string): Promise<unknown>;
  }
  class PaymentIntentResource extends StripeResource {
    create(params: object): Promise<unknown>;
    confirm(id: string): Promise<unknown>;
  }
  class CustomerResource extends StripeResource {
    retrieve(id: string): Promise<unknown>;
  }
  type WebhookObject = {
    constructEvent(payload: string, header: string, secret: string): unknown;
  };
  class Stripe {
    constructor(key: string);
    refunds: RefundResource;
    paymentIntents: PaymentIntentResource;
    customers: CustomerResource;
    webhooks: WebhookObject;
  }
  export default Stripe;
}
