import "dotenv/config";
import express, { type NextFunction, type Request, type Response } from "express";
import { MEMBERS, USERS, createSubAccount } from "./data.js";
import { createSession, destroySession, forceExpire, getSession, parseCookies, type Session } from "./session.js";
import {
  accountPanelFragment,
  crashPage,
  loginPage,
  memberDetailPage,
  membersSearchPage,
  notFoundPage,
  permissionDeniedPage,
  subAccountConfirmPage,
  subAccountFormPage,
  subAccountSuccessPage,
} from "./views.js";

declare global {
  namespace Express {
    interface Request {
      session?: Session | undefined;
      sessionToken?: string | undefined;
    }
  }
}

const app = express();
app.use(express.urlencoded({ extended: true }));

app.use((req: Request, _res: Response, next: NextFunction) => {
  const cookies = parseCookies(req.headers.cookie);
  req.sessionToken = cookies.sid;
  req.session = getSession(cookies.sid) ?? undefined;
  next();
});

/** Dev-only fault-injection levers, always active in this mock app (never a production concern). */
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.query["crash"] === "1") {
    res.status(500).send(crashPage());
    return;
  }
  next();
});

async function maybeSlow(req: Request): Promise<void> {
  if (req.query["slow"] === "1") {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session) {
    res.redirect(`/login?reason=session_expired&next=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  next();
}

function requireRole(role: Session["role"]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.session?.role !== role) {
      res.status(403).send(permissionDeniedPage());
      return;
    }
    next();
  };
}

app.get("/", (_req, res) => res.redirect("/members"));

app.get("/login", (req, res) => {
  res.send(loginPage({ expired: req.query["reason"] === "session_expired" }));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const user = USERS.find((u) => u.username === username && u.password === password);
  if (!user) {
    res.send(loginPage({ error: "Invalid username or password." }));
    return;
  }
  const session = createSession(user.username, user.role);
  res.setHeader("Set-Cookie", `sid=${session.token}; HttpOnly; Path=/; SameSite=Lax`);
  const next = typeof req.query["next"] === "string" ? req.query["next"] : "/members";
  res.redirect(next);
});

app.get("/logout", (req, res) => {
  destroySession(req.sessionToken);
  res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.redirect("/login");
});

/** Dev-only lever: force the current session to appear expired on its next use. */
app.get("/dev/expire-session", (req, res) => {
  forceExpire(req.sessionToken);
  res.redirect(req.get("referer") ?? "/members");
});

app.get("/members", requireAuth, async (req, res) => {
  const memberId = typeof req.query["memberId"] === "string" ? req.query["memberId"] : undefined;
  if (!memberId) {
    res.send(membersSearchPage({ searched: false }));
    return;
  }
  await maybeSlow(req);
  const member = MEMBERS[memberId] ?? null;
  res.send(membersSearchPage({ memberId, result: member, searched: true }));
});

app.get("/members/:id", requireAuth, (req, res) => {
  const member = MEMBERS[req.params.id!];
  if (!member) {
    res.status(404).send(notFoundPage("Member record not found."));
    return;
  }
  res.send(memberDetailPage(member, req.session!.role));
});

app.get("/members/:id/account-panel", requireAuth, async (req, res) => {
  const member = MEMBERS[req.params.id!];
  if (!member) {
    res.status(404).send(notFoundPage("Member record not found."));
    return;
  }
  await maybeSlow(req);
  res.send(accountPanelFragment(member));
});

app.get("/members/:id/sub-account/new", requireAuth, requireRole("teller"), (req, res) => {
  const member = MEMBERS[req.params.id!];
  if (!member) {
    res.status(404).send(notFoundPage("Member record not found."));
    return;
  }
  res.send(subAccountFormPage(member, {}));
});

app.post("/members/:id/sub-account/new", requireAuth, requireRole("teller"), (req, res) => {
  const member = MEMBERS[req.params.id!];
  if (!member) {
    res.status(404).send(notFoundPage("Member record not found."));
    return;
  }
  const { accountType, openingDeposit } = req.body as { accountType?: string; openingDeposit?: string };
  const amount = Number(openingDeposit);
  if (!openingDeposit || Number.isNaN(amount) || amount < 25) {
    res.send(
      subAccountFormPage(member, {
        validationError: "Opening deposit must be at least $25.00.",
        accountType,
        openingDeposit,
      }),
    );
    return;
  }
  res.send(subAccountConfirmPage(member, accountType ?? "Standard Savings", amount));
});

app.post("/members/:id/sub-account/confirm", requireAuth, requireRole("teller"), (req, res) => {
  const member = MEMBERS[req.params.id!];
  if (!member) {
    res.status(404).send(notFoundPage("Member record not found."));
    return;
  }
  const { accountType, openingDeposit } = req.body as { accountType?: string; openingDeposit?: string };
  const account = createSubAccount(member.id, accountType ?? "Standard Savings", Number(openingDeposit ?? 0));
  res.send(subAccountSuccessPage(member, account.accountNumber));
});

const port = Number(process.env.MOCK_APP_PORT ?? 4000);
app.listen(port, () => {
  console.log(`Meridian Core Banking mock app listening on http://localhost:${port}`);
});
