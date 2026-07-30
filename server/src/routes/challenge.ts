import { Router } from "express";
import { challengeState } from "../services/challengeService.js";

export const challengeRouter = Router();

// The dealer's daily challenge (#231, ADR-63): a read-only snapshot — the
// objective is derived from the local day, progress from today's rows, and
// the payout lands through completeTask / timer-stop, never through a GET.
challengeRouter.get("/", (_req, res) => {
  res.json(challengeState());
});
