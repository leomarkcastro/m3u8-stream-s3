import { config } from "./config";

export type WebhookEvent = {
    type: string;
    payload: any;
    time: string;
    server: string;
};

export const sendWebhookEvent = async (event: WebhookEvent) => {
    if (!config.WEBHOOK_URL) {
        return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetch(config.WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': config.WEBHOOK_SECRET ? `Bearer ${config.WEBHOOK_SECRET}` : '',
            },
            body: JSON.stringify(event),
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error('Failed to send webhook event');
        }
    } catch (error) {
        console.error('Webhook event failed:', error);
        // throw error;
    } finally {
        clearTimeout(timeout);
    }
}