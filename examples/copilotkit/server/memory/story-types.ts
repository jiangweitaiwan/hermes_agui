import { z } from "zod";
import { StorySchema } from "../llm/schema/story";
export type MemoryStory = z.infer<typeof StorySchema>;
