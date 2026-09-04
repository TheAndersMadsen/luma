import { browserAssistantRequest } from "@/server/browserAssistant";
export const POST = (request: Request) => browserAssistantRequest(request, "stream");
