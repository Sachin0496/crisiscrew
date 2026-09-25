/*
 * CrisisCrew in the Freshdesk ticket sidebar. Reads the open ticket's id,
 * asks CrisisCrew what it knows about that ticket's customer through the
 * getTicketImpact request template, and renders it with render.js.
 */
(function () {
  "use strict";

  function show(html) {
    document.getElementById("app").innerHTML = html;
  }

  function showError(message) {
    show('<div class="empty error"><strong>CrisisCrew is unreachable</strong><p>' + self.CrisisCrewSidebar.escapeHtml(message) + "</p></div>");
  }

  async function refresh(client) {
    try {
      const { ticket } = await client.data.get("ticket");
      const res = await client.request.invokeTemplate("getTicketImpact", { context: { ticket_id: ticket.id } });
      show(self.CrisisCrewSidebar.renderImpact(JSON.parse(res.response)));
    } catch (error) {
      const status = error && error.status ? " (HTTP " + error.status + ")" : "";
      showError("Check the CrisisCrew host in the app settings and that the server is running" + status + ".");
    }
  }

  async function start() {
    const client = await app.initialized();
    client.events.on("app.activated", function () {
      refresh(client);
    });
    document.getElementById("refresh").addEventListener("click", function () {
      refresh(client);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    start().catch(function () {
      showError("The Freshdesk app client didn't start.");
    });
  });
})();
