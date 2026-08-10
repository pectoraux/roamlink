/**
 * Notification service — abstraction over delivery channels.
 *
 * Initially implemented with a DB-backed log (development). The interface is
 * ready for email / SMS / push / WhatsApp providers to be plugged in without
 * changing call sites.
 */

import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

export type NotificationEvent =
  | "order.confirmed"
  | "payment.successful"
  | "esim.provisioned"
  | "esim.installation_available"
  | "esim.expiring"
  | "esim.data_nearly_exhausted"
  | "topup.successful";

export type NotificationChannel = "email" | "sms" | "push" | "whatsapp" | "log";

export async function sendNotification(input: {
  userId?: string;
  channel?: NotificationChannel;
  event: NotificationEvent;
  recipient?: string;
  subject?: string;
  body: string;
}): Promise<void> {
  const channel = input.channel ?? "log";
  // Persist (development implementation).
  await db.notification.create({
    data: {
      userId: input.userId ?? null,
      channel,
      event: input.event,
      recipient: input.recipient ?? null,
      subject: input.subject ?? null,
      body: input.body,
      status: "sent",
    },
  });
  logger.info("notification.sent", { event: input.event, channel, userId: input.userId });
}

/** Convenience helpers for the key lifecycle events. */
export const notify = {
  paymentSuccessful: (userId: string, orderId: string, amount: string) =>
    sendNotification({
      userId,
      event: "payment.successful",
      subject: "Payment received",
      body: `Your payment of ${amount} for order ${orderId} has been received. We're activating your eSIM.`,
    }),
  esimProvisioned: (userId: string, esimId: string, country: string) =>
    sendNotification({
      userId,
      event: "esim.provisioned",
      subject: "Your eSIM is ready",
      body: `Your eSIM for ${country} has been activated. Open My eSIMs to install it.`,
    }),
  topUpSuccessful: (userId: string, esimId: string, dataAddedMB: number) =>
    sendNotification({
      userId,
      event: "topup.successful",
      subject: "Top-up successful",
      body: `Your top-up of ${dataAddedMB} MB has been applied to eSIM ${esimId}.`,
    }),
};
