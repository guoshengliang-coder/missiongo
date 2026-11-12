import { expect, it } from "vitest";
import { insertCommonCommand } from "./common-command-insertion";
it("inserts without replacing selected content and respects the message limit",()=>{
 expect(insertCommonCommand("","hello",0)).toBe("hello");
 expect(insertCommonCommand("before after","instruction",7)).toBe("before \ninstruction\nafter");
 expect(insertCommonCommand("old","new",3)).toBe("old\nnew");
 expect(insertCommonCommand("old","new",3,6)).toBeNull();
});
