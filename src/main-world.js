/**
 * OceanCRM — MAIN World Script
 *
 * Runs in the page context (MAIN world) where window.WPP is available.
 * Listens for "ocean-request" CustomEvents from the ISOLATED world (content.js)
 * and responds with "ocean-response" events containing WPP API results.
 *
 * This script CANNOT access chrome.runtime, chrome.storage, or any
 * extension APIs — those are only available in the ISOLATED world.
 */

(function () {
  "use strict";

  /**
   * Wait for WPP to be ready before accepting requests.
   * wa-inject.js sets window.WPP when loaded.
   */
  let wppReady = false;

  function checkWPPReady() {
    if (typeof window.WPP !== "undefined" && window.WPP.isReady) {
      wppReady = true;
      console.log("[OceanCRM:MAIN] WPP.js is ready");
      window.dispatchEvent(
        new CustomEvent("ocean-wpp-ready", { detail: { ready: true } }),
      );
      return;
    }
    // Retry every 500ms
    setTimeout(checkWPPReady, 500);
  }

  checkWPPReady();

  /**
   * Handle requests from ISOLATED world (content.js).
   * Each request has: { id, type, payload }
   * We respond with: { id, type, result, error }
   */
  window.addEventListener("ocean-request", async function (event) {
    const { id, type, payload } = event.detail;

    if (!wppReady) {
      sendResponse(id, type, null, "WPP not ready yet");
      return;
    }

    try {
      let result = null;

      switch (type) {
        case "getChatList": {
          const chats = await WPP.chat.list(payload || {});
          // Return simplified chat data to keep the message small
          result = chats.map(function (chat) {
            return {
              id: {
                user: chat.id.user,
                server: chat.id.server,
                _serialized: chat.id._serialized,
              },
              name: chat.name || chat.formattedTitle || "",
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              archive: chat.archive || false,
              timestamp: chat.t || 0,
            };
          });
          break;
        }

        case "findChat": {
          result = await WPP.chat.find(payload.phone);
          if (result) {
            result = {
              id: {
                user: result.id.user,
                server: result.id.server,
                _serialized: result.id._serialized,
              },
              name: result.name || result.formattedTitle || "",
            };
          }
          break;
        }

        case "getContact": {
          const contact = await WPP.contact.get(payload.contactId);
          result = contact
            ? {
                id: contact.id._serialized,
                name: contact.name || contact.pushname || "",
                shortName: contact.shortName || "",
                number: contact.id.user,
              }
            : null;
          break;
        }

        case "checkContactExists": {
          const exists = await WPP.contact.queryExists(payload.phone);
          result = exists
            ? {
                exists: true,
                jid: exists.wid._serialized,
                user: exists.wid.user,
              }
            : { exists: false };
          break;
        }

        case "getMyId": {
          const myId = WPP.conn.getMyUserId();
          result = { user: myId.user, _serialized: myId._serialized };
          break;
        }

        case "isWPPReady": {
          result = { ready: wppReady };
          break;
        }

        case "openChat": {
          // Open chat in WhatsApp's native UI
          try {
            if (WPP.chat.openChatBottom) {
              await WPP.chat.openChatBottom(payload.chatId);
            } else if (WPP.chat.openChatAt) {
              await WPP.chat.openChatAt(payload.chatId);
            } else {
              var chatModel = await WPP.chat.get(payload.chatId);
              if (chatModel) {
                await WPP.chat.openChatFromUnread(payload.chatId);
              }
            }
            result = { opened: true };
          } catch (e) {
            // Absolute fallback: URL hash navigation
            var phone = payload.chatId.split("@")[0];
            window.location.hash = "#/chat/" + phone;
            result = { opened: true, method: "hash" };
          }
          break;
        }

        case "getChatListEnriched": {
          // Like getChatList but includes last message body
          const chats = await WPP.chat.list(payload || {});
          result = [];
          for (var i = 0; i < chats.length; i++) {
            var chat = chats[i];
            var lastMsg = "";
            var lastMsgType = "";
            try {
              var msgs =
                chat.msgs && chat.msgs.getModelsArray
                  ? chat.msgs.getModelsArray()
                  : [];
              if (msgs.length > 0) {
                var last = msgs[msgs.length - 1];
                lastMsg = last.body || last.caption || "";
                lastMsgType = last.type || "chat";
                // Truncate long messages
                if (lastMsg.length > 100)
                  lastMsg = lastMsg.substring(0, 100) + "...";
              }
            } catch (e) {
              // Ignore message extraction errors
            }
            result.push({
              id: {
                user: chat.id.user,
                server: chat.id.server,
                _serialized: chat.id._serialized,
              },
              name: chat.name || chat.formattedTitle || "",
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              archive: chat.archive || false,
              timestamp: chat.t || 0,
              lastMessageBody: lastMsg,
              lastMessageType: lastMsgType,
            });
          }
          break;
        }

        default:
          sendResponse(id, type, null, "Unknown request type: " + type);
          return;
      }

      sendResponse(id, type, result, null);
    } catch (err) {
      console.error("[OceanCRM:MAIN] Error handling " + type, err);
      sendResponse(id, type, null, err.message || String(err));
    }
  });

  /**
   * Send response back to ISOLATED world.
   */
  function sendResponse(id, type, result, error) {
    window.dispatchEvent(
      new CustomEvent("ocean-response", {
        detail: { id: id, type: type, result: result, error: error },
      }),
    );
  }

  console.log("[OceanCRM:MAIN] Main world script loaded, waiting for WPP...");
})();
