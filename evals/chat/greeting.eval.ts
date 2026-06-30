import { defineEval } from "eve/evals";

// A casual greeting must not trigger any trading action.
export default defineEval({
  async test(t) {
    await t.send("hey, you around?");
    t.completed();
    t.notCalledTool("submit_orders");
    t.notCalledTool("manage_positions");
  },
});
