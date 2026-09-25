/*
 * Renders CrisisCrew's view of one Freshdesk ticket (the JSON from
 * GET /api/freshdesk/tickets/:id) as the sidebar's HTML. Pure: no Freshworks
 * client, no network, so the same code is checked against the server's real
 * payload in CrisisCrew's tests.
 */
(function (root) {
  "use strict";

  var STATE = {
    recovered: { label: "Recovered", tone: "success" },
    needs_human: { label: "Needs a human", tone: "warning" },
    in_progress: { label: "In progress", tone: "accent" },
    attention: { label: "Needs attention", tone: "danger" },
    unverified: { label: "Not verified", tone: "neutral" }
  };

  var STATUS = {
    detected: "Detected",
    investigating: "Investigating",
    root_cause_identified: "Root cause identified",
    recovering: "Recovering",
    awaiting_approval: "Awaiting approval",
    recovered: "Recovered",
    resolved: "Resolved",
    dismissed: "Dismissed"
  };

  var ACTION = {
    ticket_reply: "Reply on this ticket",
    acknowledge: "Acknowledgement",
    proactive_message: "Proactive message",
    voice: "Voice update",
    account_note: "Account note",
    credit: "Goodwill credit",
    no_credit: "No credit"
  };

  var ACTION_STATUS = {
    planned: "Planned",
    done: "Done",
    prepared: "Prepared",
    awaiting_approval: "Waiting for approval",
    declined: "Declined",
    failed: "Failed"
  };

  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return ESCAPES[ch];
    });
  }

  function inr(amount) {
    return "₹" + Math.round(amount).toLocaleString("en-IN");
  }

  function badge(text, tone) {
    return '<span class="badge badge-' + (tone || "neutral") + '">' + escapeHtml(text) + "</span>";
  }

  function section(title, body) {
    return '<section class="section"><h2 class="section-title">' + escapeHtml(title) + "</h2>" + body + "</section>";
  }

  function link(url) {
    return url ? '<a class="console-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">Open in CrisisCrew</a>' : "";
  }

  /** The sidebar's HTML for one ticket. */
  function renderImpact(data) {
    if (!data || data.tracked !== true) {
      return (
        '<div class="empty"><strong>Not tracked yet</strong><p>' +
        escapeHtml((data && data.message) || "CrisisCrew hasn't seen this ticket in the current session.") +
        "</p></div>"
      );
    }

    var incident = data.incident;
    if (!incident) {
      var kind = data.ticket.reportsFailure === true ? "a failure report" : data.ticket.reportsFailure === false ? "a question or request" : "a ticket";
      return (
        '<div class="empty"><strong>Not part of an incident</strong><p>CrisisCrew read this as ' +
        escapeHtml(kind) +
        " and matched it to no incident.</p></div>"
      );
    }

    var coverage = incident.coverage;
    var html =
      '<header class="incident">' +
      '<div class="incident-title">' +
      escapeHtml(incident.title) +
      "</div>" +
      '<div class="incident-meta"><span class="mono">' +
      escapeHtml(incident.id) +
      "</span> " +
      badge(STATUS[incident.status] || incident.status, incident.status === "recovered" ? "success" : incident.status === "awaiting_approval" ? "warning" : "accent") +
      "</div>" +
      (incident.rootCause
        ? '<div class="incident-cause">Likely cause: <strong>' +
          escapeHtml(incident.rootCause.label) +
          "</strong> (" +
          Math.round(incident.rootCause.confidence * 100) +
          "%)</div>"
        : "") +
      '<div class="coverage"><div class="coverage-row"><span>Recovery coverage</span><strong>' +
      coverage.recovered +
      "/" +
      coverage.confirmed +
      '</strong></div><div class="meter"><span style="width:' +
      (coverage.confirmed ? Math.round((coverage.recovered / coverage.confirmed) * 100) : 0) +
      '%"></span></div><div class="coverage-sub">' +
      coverage.complained +
      " complained · " +
      coverage.silent +
      " silent" +
      (coverage.needsHuman ? " · " + coverage.needsHuman + " need a human" : "") +
      "</div></div>" +
      "</header>";

    var customer = data.customer;
    if (!customer) {
      return html + section("This customer", '<p class="muted">Linked to the incident; their impact is still being assessed.</p>') + link(data.consoleUrl);
    }

    var state = STATE[customer.state] || STATE.in_progress;
    html += section(
      "This customer",
      '<div class="customer"><strong>' +
        escapeHtml(customer.name) +
        "</strong> " +
        badge(state.label, state.tone) +
        "</div>" +
        '<p class="confidence">' +
        (customer.confidence === "confirmed"
          ? "Confirmed from a failed or pending payment inside the incident window."
          : "Not verified: no failed payment is on record, so there's an acknowledgement and no credit until there's evidence.") +
        "</p>"
    );

    var evidence = (customer.evidence || [])
      .filter(function (e) {
        return e.kind !== "reported" && e.kind !== "no_ticket";
      })
      .slice(0, 5)
      .map(function (e) {
        return "<li>" + escapeHtml(e.label) + "</li>";
      })
      .join("");
    if (evidence) html += section("Evidence", '<ul class="evidence">' + evidence + "</ul>");

    var actions = (customer.actions || [])
      .map(function (a) {
        var name = (ACTION[a.kind] || a.kind) + (a.kind === "credit" && a.amountInr ? " · " + inr(a.amountInr) : "");
        var status = a.kind === "no_credit" ? "" : badge(ACTION_STATUS[a.status] || a.status, a.status === "done" ? "success" : a.status === "awaiting_approval" ? "warning" : a.status === "failed" ? "danger" : "neutral");
        return '<li><div class="action-row"><span>' + escapeHtml(name) + "</span>" + status + '</div><div class="muted">' + escapeHtml(a.reason) + ".</div></li>";
      })
      .join("");
    if (actions) html += section("Recovery", '<ul class="actions">' + actions + "</ul>");

    if (data.pendingApproval) {
      html +=
        '<div class="callout">' +
        escapeHtml(inr(data.pendingApproval.amountInr)) +
        " credit is waiting for a human decision in CrisisCrew (" +
        escapeHtml(data.pendingApproval.id) +
        ").</div>";
    }
    return html + link(data.consoleUrl);
  }

  var api = { renderImpact: renderImpact, escapeHtml: escapeHtml };
  root.CrisisCrewSidebar = api;
})(typeof self !== "undefined" ? self : globalThis);
