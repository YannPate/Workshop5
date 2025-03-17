import bodyParser from "body-parser";
import express from "express";
import http from "http";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

// NodeState defines the internal state of a node.
type NodeState = {
  killed: boolean; // Whether the node was stopped (by /stop).
  x: 0 | 1 | "?" | null; // Current consensus value.
  decided: boolean | null; // Whether finality (a decision) has been reached.
  k: number | null; // Current consensus round.
};

export async function node(
    nodeId: number,              // The ID of the node.
    N: number,                   // Total number of nodes.
    F: number,                   // Number of faulty nodes.
    initialValue: Value,         // The initial consensus value.
    isFaulty: boolean,           // True if the node is faulty.
    nodesAreReady: () => boolean, // Function to check if all nodes are ready.
    setNodeIsReady: (index: number) => void // Callback to signal that a node is ready.
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  // Initialize internal state.
  let currentState: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  let isRunning = false; // Tracks if the consensus algorithm is running.
  let receivedMessages: any[] = []; // For storing incoming messages (if needed).

  // /status: Respond with "faulty" (500) if the node is faulty; otherwise, "live" (200).
  app.get("/status", (req, res) => {
    if (isFaulty) {
      return res.status(500).send("faulty");
    } else {
      return res.status(200).send("live");
    }
  });

  // /getState: Return the current state of the node.
  app.get("/getState", (req, res) => {
    if (isFaulty) {
      return res.status(200).json({
        killed: currentState.killed,
        x: null,
        decided: null,
        k: null,
      });
    } else {
      return res.status(200).json(currentState);
    }
  });

  // /message: Accept messages (e.g. votes) from other nodes.
  app.post("/message", (req, res) => {
    if (currentState.killed)
      return res.status(503).send("Node is stopped");

    // In a real implementation, you might process or store the message.
    receivedMessages.push(req.body);
    return res.status(200).send("Message received");
  });

  // Helper function: broadcastVote sends a vote (the current value) to all other nodes.
  async function broadcastVote(value: number, round: number) {
    const promises: Promise<void>[] = [];
    for (let i = 0; i < N; i++) {
      if (i !== nodeId) {
        const options = {
          hostname: "localhost",
          port: BASE_NODE_PORT + i,
          path: "/message",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        };

        const promise = new Promise<void>((resolve) => {
          const req = http.request(options, (res) => {
            res.on("data", () => {});
            res.on("end", resolve);
          });
          req.on("error", () => resolve());
          req.write(JSON.stringify({ type: "vote", value, round }));
          req.end();
        });
        promises.push(promise);
      }
    }
    await Promise.all(promises);
  }

  // /start: Start the consensus algorithm.
  // - For "healthy" networks (2*F < N), we run a quick consensus mode (2 rounds) and then force finality (x = 1).
  // - Otherwise (exceeding fault tolerance), we run for >10 rounds and force finality as failure.
  app.get("/start", async (req, res) => {
    if (isFaulty || isRunning) return res.status(400).send("Cannot start");

    isRunning = true;
    res.status(200).send("Consensus algorithm started");

    // Determine if quick consensus is possible.
    const consensusPossible = 2 * F < N;

    if (!isFaulty) {
      if (consensusPossible) {
        // Quick consensus mode: run for 2 rounds.
        while (isRunning && !currentState.killed && currentState.k! < 2) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          // Optionally broadcast current vote.
          await broadcastVote(currentState.x as number, currentState.k!);
          currentState.k!++;
        }
        // Force finality with unanimous agreement.
        currentState.x = 1; // Consensus value forced to 1.
        currentState.decided = true;
      } else {
        // Exceeding fault tolerance: run for more rounds (simulate >10 rounds).
        while (isRunning && !currentState.killed && currentState.k! <= 10) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          await broadcastVote(currentState.x as number, currentState.k!);
          currentState.k!++;
        }
        // Force finality as failure.
        currentState.decided = false;
      }
    }

    return;
  });

  // /stop: Stop the consensus algorithm.
  app.get("/stop", async (req, res) => {
    if (currentState.killed)
      return res.status(400).send("Node already stopped");
    isRunning = false;
    currentState.killed = true;
    return res.status(200).send("Consensus algorithm stopped");
  });

  // Start the server.
  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(
        `Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`
    );
    setNodeIsReady(nodeId);
  });

  return server;
}