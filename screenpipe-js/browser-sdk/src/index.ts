import type {
  InputAction,
  InputControlResponse,
  NotificationOptions,
  ScreenpipeQueryParams,
  ScreenpipeResponse,
  TranscriptionChunk,
  TranscriptionStreamResponse,
  VisionEvent,
  VisionStreamResponse,
} from "../../common/types";
import { toSnakeCase, convertToCamelCase } from "../../common/utils";

async function sendInputControl(action: InputAction): Promise<boolean> {
  const apiUrl = "http://localhost:3030";
  try {
    const response = await fetch(`${apiUrl}/experimental/input_control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!response.ok) {
      throw new Error(`http error! status: ${response.status}`);
    }
    const data: InputControlResponse = await response.json();
    return data.success;
  } catch (error) {
    console.error("failed to control input:", error);
    return false;
  }
}

export interface BrowserPipe {
  sendDesktopNotification(options: NotificationOptions): Promise<boolean>;
  queryScreenpipe(
    params: ScreenpipeQueryParams
  ): Promise<ScreenpipeResponse | null>;
  input: {
    type: (text: string) => Promise<boolean>;
    press: (key: string) => Promise<boolean>;
    moveMouse: (x: number, y: number) => Promise<boolean>;
    click: (button: "left" | "right" | "middle") => Promise<boolean>;
  };
  streamTranscriptions(): AsyncGenerator<
    TranscriptionStreamResponse,
    void,
    unknown
  >;
  streamVision(
    includeImages?: boolean
  ): AsyncGenerator<VisionStreamResponse, void, unknown>;
}

// Browser-only implementations
export const pipe: BrowserPipe = {
  async sendDesktopNotification(
    options: NotificationOptions
  ): Promise<boolean> {
    const notificationApiUrl = "http://localhost:11435";
    try {
      await fetch(`${notificationApiUrl}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      });
      return true;
    } catch (error) {
      console.error("failed to send notification:", error);
      return false;
    }
  },

  async queryScreenpipe(
    params: ScreenpipeQueryParams
  ): Promise<ScreenpipeResponse | null> {
    const queryParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== "") {
        if (key === "speakerIds" && Array.isArray(value)) {
          if (value.length > 0) {
            queryParams.append(toSnakeCase(key), value.join(","));
          }
        } else {
          const snakeKey = toSnakeCase(key);
          queryParams.append(snakeKey, value!.toString());
        }
      }
    });

    const url = `http://localhost:3030/search?${queryParams}`;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errorText = await response.text();
        let errorJson;
        try {
          errorJson = JSON.parse(errorText);
          console.error("screenpipe api error:", {
            status: response.status,
            error: errorJson,
          });
        } catch {
          console.error("screenpipe api error:", {
            status: response.status,
            error: errorText,
          });
        }
        throw new Error(`http error! status: ${response.status}`);
      }
      const data = await response.json();
      return convertToCamelCase(data) as ScreenpipeResponse;
    } catch (error) {
      console.error("error querying screenpipe:", error);
      return null;
    }
  },

  input: {
    type: (text: string) => sendInputControl({ type: "WriteText", data: text }),
    press: (key: string) => sendInputControl({ type: "KeyPress", data: key }),
    moveMouse: (x: number, y: number) =>
      sendInputControl({ type: "MouseMove", data: { x, y } }),
    click: (button: "left" | "right" | "middle") =>
      sendInputControl({ type: "MouseClick", data: button }),
  },

  async *streamTranscriptions(): AsyncGenerator<
    TranscriptionStreamResponse,
    void,
    unknown
  > {
    const eventSource = new EventSource(
      "http://localhost:3030/sse/transcriptions"
    );

    try {
      while (true) {
        const chunk: TranscriptionChunk = await new Promise(
          (resolve, reject) => {
            eventSource.onmessage = (event) => {
              if (event.data.trim() === "keep-alive-text") {
                return;
              }
              resolve(JSON.parse(event.data));
            };
            eventSource.onerror = (error) => {
              reject(error);
            };
          }
        );

        yield {
          id: crypto.randomUUID(),
          object: "text_completion_chunk",
          created: Date.now(),
          model: "screenpipe-realtime",
          choices: [
            {
              text: chunk.transcription,
              index: 0,
              finish_reason: chunk.is_final ? "stop" : null,
            },
          ],
          metadata: {
            timestamp: chunk.timestamp,
            device: chunk.device,
            isInput: chunk.is_input,
          },
        };
      }
    } finally {
      eventSource.close();
    }
  },

  async *streamVision(
    includeImages: boolean = false
  ): AsyncGenerator<VisionStreamResponse, void, unknown> {
    const eventSource = new EventSource(
      `http://localhost:3030/sse/vision?images=${includeImages}`
    );

    try {
      while (true) {
        const event: VisionEvent = await new Promise((resolve, reject) => {
          eventSource.onmessage = (event) => {
            resolve(JSON.parse(event.data));
          };
          eventSource.onerror = (error) => {
            reject(error);
          };
        });

        yield {
          type: "vision_stream",
          data: event,
        };
      }
    } finally {
      eventSource.close();
    }
  },
};

const sendDesktopNotification = pipe.sendDesktopNotification;
const queryScreenpipe = pipe.queryScreenpipe;
const input = pipe.input;

export { sendDesktopNotification, queryScreenpipe, input };
export {
  toCamelCase,
  toSnakeCase,
  convertToCamelCase,
} from "../../common/utils";
export * from "../../common/types";
