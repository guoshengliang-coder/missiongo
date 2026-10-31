import { MissionGoError } from "./errors.js";
import { DWClient, TOPIC_CARD } from "dingtalk-stream";

/** Only card actions are subscribed: free-form robot chat never becomes a comment. */
export class DingTalkCardStream {
  private readonly client: DWClient;
  constructor(clientId: string, clientSecret: string, onCard: (body: unknown) => Record<string,unknown>) {
    this.client = new DWClient({clientId,clientSecret,debug:false,keepAlive:true});
    this.client.registerCallbackListener(TOPIC_CARD, frame => {
      let result: Record<string,unknown>;
      try {
        if (frame.data.length > 100_000) throw new Error("oversized callback");
        result = onCard(JSON.parse(frame.data));
      } catch(error) {
        const reason=error instanceof MissionGoError ? error.message : "回复未保存，请回条目重试。";
        result = {cardData:{cardParamMap:{replyStatus:reason,replySaved:"false"}}};
      }
      this.client.socketCallBackResponse(frame.headers.messageId,result);
    });
  }
  start(): void { void this.client.connect().catch(() => { /* SDK reconnects; never log credentials or payloads. */ }); }
  close(): void { this.client.disconnect(); }
}
