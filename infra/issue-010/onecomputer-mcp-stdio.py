#!/usr/bin/env python3
"""Credentialless stdio MCP bridge for Claude Desktop inside a managed workspace."""

from __future__ import annotations

import base64
import binascii
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request


BROKER = os.environ.get("ONECOMPUTER_MCP_BROKER", "http://127.0.0.1:4312")
if BROKER not in {
    "http://127.0.0.1:4312",
    "http://127.0.0.1:4314",
    "http://127.0.0.1:4315",
    "http://127.0.0.1:4316",
    "http://127.0.0.1:4317",
}:
    raise SystemExit("invalid ONEComputer MCP broker")
PROTOCOL_VERSION = "2024-11-05"
TOOLS: dict[str, dict] = {}
RESPONSE_LOCK = threading.Lock()
WAIT_TOOL_NAME = "wait-for-governed-operation"
WRITE_TOOLS = {
    "create-draft-email", "update-mail-message", "delete-mail-message", "move-mail-message",
    "send-mail", "send-draft-message", "reply-mail-message", "reply-all-mail-message", "forward-mail-message",
    "create-calendar-event", "update-calendar-event", "delete-calendar-event", "create-onedrive-folder",
    "upload-file-content", "move-rename-onedrive-item", "copy-drive-item", "delete-onedrive-file",
    "send-chat-message", "reply-to-chat-message", "send-channel-message", "reply-to-channel-message",
}
DELETE_ONEDRIVE_DESCRIPTION = """Delete one Microsoft OneDrive or SharePoint drive item through ONEComputer governance.

This is a remote Microsoft 365 action, not a local filesystem action. A user-facing filename, link, folder path, or filename visible in an attached screenshot is enough to begin discovery: call list-drives to resolve driveId, then search-onedrive-files or list-folder-files to resolve the exact driveItemId. Do not ask the user for internal drive or item IDs before attempting those assigned discovery tools. If multiple items match, ask the user to disambiguate before deleting anything.

Before calling this tool, get the exact item's current top-level eTag with get-drive-item (includeHeaders=true and select=id,name,eTag,parentReference). Pass that exact eTag as If-Match. Call this tool directly; do not request Cowork or local-file deletion permission. ONEComputer Control will obtain any required signed approval and this call will wait for the final result."""
DELETE_ONEDRIVE_MISSING_ETAG = """The remote OneDrive deletion was not submitted because If-Match is missing. Call get-drive-item for this driveId and driveItemId with includeHeaders=true and select=id,name,eTag,parentReference, then call delete-onedrive-file again with the exact top-level eTag as If-Match. Do not use Cowork or local-filesystem deletion permission; ONEComputer handles approval when this remote tool is called."""
CALENDAR_VIEW_DESCRIPTION = """Get chronological event occurrences from the signed-in user's default Outlook calendar within an explicit time window.

Use this tool for requests such as next, upcoming, today, this week, or events between two dates. For upcoming events, set startDateTime to the current time and endDateTime to a bounded future time in ISO 8601 format. Do not use list-calendar-events for upcoming events because that tool returns event series without an implicit from-now window."""
LIST_DRIVES_DESCRIPTION = """List the signed-in user's available OneDrive and SharePoint drives.

Use this first when a OneDrive request supplies a human-facing filename, link, or path but no driveId. Omit top or set it to at least 2: Microsoft Graph can return an empty first page plus a next link when top is 1. Continue with search-onedrive-files or list-folder-files; do not ask the user to provide an internal drive ID before attempting this discovery."""
SEARCH_ONEDRIVE_DESCRIPTION = """Search one OneDrive or SharePoint drive for items matching a human-facing filename.

If driveId is unknown, call list-drives first. Search using the filename or other value the user supplied, including a filename visible in an attached screenshot. Use top no greater than 10 and the exact select value id,name,eTag,parentReference. Do not request all pages. OneDrive search is eventually consistent, so use list-folder-files on the known parent immediately after creating an item. Treat multiple matches as ambiguous and ask the user to choose before a mutation."""
UPLOAD_ONEDRIVE_DESCRIPTION = """Create or replace one file in Microsoft OneDrive or SharePoint through ONEComputer governance.

Pass driveId from list-drives. Pass only the value that belongs between `/items/` and `/content` as driveItemId: use an opaque item ID to replace an existing file, `root:/file.txt:` for a new file in the drive root, or `root:/folder/file.txt:` for a new file below the root. Never include `/items/`, `/content`, `/drives/`, or a complete Microsoft Graph URL in driveItemId. Body must be the file bytes encoded as base64. To verify a just-created file, call list-folder-files on its parent because OneDrive search indexing can lag. Call this tool directly; ONEComputer obtains any required signed approval."""
LIST_JOINED_TEAMS_DESCRIPTION = """List every Microsoft Teams team joined by the signed-in user.

This Graph endpoint does not accept generic OData paging or filtering options. Call it with no arguments, then match the returned displayName and id locally. Use the selected id with list-team-channels."""
TEAMS_TOOL_DESCRIPTIONS = {
    "send-chat-message": "Send one HTML message to an existing Teams chat. Get chatId from list-chats. Put the message in body.body.content and set body.body.contentType to html. ONEComputer obtains signed approval before sending.",
    "reply-to-chat-message": "Reply with one HTML message to an existing Teams chat message. Get chatId from list-chats and chatMessageId from list-chat-messages. Put the reply in body.body.content and set body.body.contentType to html. ONEComputer obtains signed approval before sending.",
    "send-channel-message": "Post one HTML message to a Teams channel. Get teamId from list-joined-teams and channelId from list-team-channels. Put the post in body.body.content and set body.body.contentType to html. ONEComputer obtains signed approval before posting.",
    "reply-to-channel-message": "Reply with one HTML message to a Teams channel post. Get teamId from list-joined-teams, channelId from list-team-channels, and the parent chatMessageId from list-channel-messages. Put the reply in body.body.content and set body.body.contentType to html. ONEComputer obtains signed approval before posting.",
}

LIST_DRIVES_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "top": {"type": "integer", "minimum": 2, "maximum": 25},
        "skip": {"type": "integer", "minimum": 0, "maximum": 1000},
        "select": {"type": "string", "minLength": 1, "maxLength": 256},
        "filter": {"type": "string", "minLength": 1, "maxLength": 512},
        "search": {"type": "string", "minLength": 1, "maxLength": 256},
        "orderby": {"type": "string", "minLength": 1, "maxLength": 128},
        "count": {"type": "boolean"},
    },
    "additionalProperties": False,
}
SEARCH_ONEDRIVE_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "driveId": {"type": "string", "minLength": 1, "maxLength": 512},
        "q": {"type": "string", "minLength": 1, "maxLength": 128},
        "select": {"type": "string", "const": "id,name,eTag,parentReference"},
        "top": {"type": "integer", "minimum": 1, "maximum": 10},
    },
    "required": ["driveId", "q"],
    "additionalProperties": False,
}
UPLOAD_ONEDRIVE_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "driveId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512,
            "description": "Opaque drive ID returned by list-drives.",
        },
        "driveItemId": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1024,
            "pattern": r"^(?!/?items/)(?!/?drives/)(?!https?://).+",
            "description": "Only the item ID or drive-relative path selector, for example root:/happy.txt:. Do not include /items/ or /content.",
            "examples": ["root:/happy.txt:", "root:/Documents/happy.txt:"],
        },
        "body": {
            "type": "string",
            "minLength": 1,
            "maxLength": 5_600_000,
            "contentEncoding": "base64",
            "description": "Base64-encoded file bytes, not plain text.",
        },
    },
    "required": ["driveId", "driveItemId", "body"],
    "additionalProperties": False,
}
NO_ARGUMENTS_INPUT_SCHEMA = {
    "type": "object",
    "properties": {},
    "additionalProperties": False,
}
TEAMS_MESSAGE_BODY_SCHEMA = {
    "type": "object",
    "properties": {
        "body": {
            "type": "object",
            "properties": {
                "contentType": {
                    "type": "string",
                    "const": "html",
                    "description": "Use html; Microsoft Graph can mangle plain-text Teams messages.",
                },
                "content": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 28000,
                    "description": "The HTML message content.",
                },
            },
            "required": ["contentType", "content"],
            "additionalProperties": False,
        },
    },
    "required": ["body"],
    "additionalProperties": False,
}


def teams_message_input_schema(*identifiers: str) -> dict:
    properties = {
        identifier: {
            "type": "string",
            "minLength": 1,
            "maxLength": 512,
            "description": f"Opaque {identifier} returned by the corresponding Teams discovery tool.",
        }
        for identifier in identifiers
    }
    properties["body"] = TEAMS_MESSAGE_BODY_SCHEMA
    return {
        "type": "object",
        "properties": properties,
        "required": [*identifiers, "body"],
        "additionalProperties": False,
    }


TEAMS_INPUT_SCHEMAS = {
    "send-chat-message": teams_message_input_schema("chatId"),
    "reply-to-chat-message": teams_message_input_schema("chatId", "chatMessageId"),
    "send-channel-message": teams_message_input_schema("teamId", "channelId"),
    "reply-to-channel-message": teams_message_input_schema("teamId", "channelId", "chatMessageId"),
}
EMAIL_ADDRESS_SCHEMA = {
    "type": "object",
    "properties": {
        "emailAddress": {
            "type": "object",
            "properties": {
                "address": {"type": "string", "format": "email"},
                "name": {"type": "string", "minLength": 1, "maxLength": 256},
            },
            "required": ["address"],
            "additionalProperties": False,
        },
    },
    "required": ["emailAddress"],
    "additionalProperties": False,
}
ITEM_BODY_SCHEMA = {
    "type": "object",
    "properties": {
        "contentType": {"type": "string", "enum": ["text", "html"]},
        "content": {"type": "string", "minLength": 1, "maxLength": 100000},
    },
    "required": ["contentType", "content"],
    "additionalProperties": False,
}
MAIL_MESSAGE_PROPERTIES = {
    "subject": {"type": "string", "minLength": 1, "maxLength": 998},
    "body": ITEM_BODY_SCHEMA,
    "toRecipients": {"type": "array", "items": EMAIL_ADDRESS_SCHEMA, "maxItems": 100},
    "ccRecipients": {"type": "array", "items": EMAIL_ADDRESS_SCHEMA, "maxItems": 100},
    "bccRecipients": {"type": "array", "items": EMAIL_ADDRESS_SCHEMA, "maxItems": 100},
    "importance": {"type": "string", "enum": ["low", "normal", "high"]},
}
MAIL_MESSAGE_SCHEMA = {
    "type": "object",
    "properties": MAIL_MESSAGE_PROPERTIES,
    "required": ["subject", "body"],
    "additionalProperties": False,
}
MAIL_PATCH_SCHEMA = {
    "type": "object",
    "properties": MAIL_MESSAGE_PROPERTIES,
    "minProperties": 1,
    "additionalProperties": False,
}
RECIPIENTS_SCHEMA = {"type": "array", "items": EMAIL_ADDRESS_SCHEMA, "minItems": 1, "maxItems": 100}
DATE_TIME_ZONE_SCHEMA = {
    "type": "object",
    "properties": {
        "dateTime": {"type": "string", "minLength": 1, "maxLength": 64},
        "timeZone": {"type": "string", "minLength": 1, "maxLength": 64},
    },
    "required": ["dateTime", "timeZone"],
    "additionalProperties": False,
}
CALENDAR_EVENT_PROPERTIES = {
    "subject": {"type": "string", "minLength": 1, "maxLength": 998},
    "start": DATE_TIME_ZONE_SCHEMA,
    "end": DATE_TIME_ZONE_SCHEMA,
    "body": ITEM_BODY_SCHEMA,
    "location": {
        "type": "object",
        "properties": {"displayName": {"type": "string", "minLength": 1, "maxLength": 512}},
        "required": ["displayName"],
        "additionalProperties": False,
    },
    "attendees": {
        "type": "array",
        "maxItems": 100,
        "items": {
            "type": "object",
            "properties": {
                "emailAddress": EMAIL_ADDRESS_SCHEMA["properties"]["emailAddress"],
                "type": {"type": "string", "enum": ["required", "optional", "resource"]},
            },
            "required": ["emailAddress", "type"],
            "additionalProperties": False,
        },
    },
    "isAllDay": {"type": "boolean"},
    "isOnlineMeeting": {"type": "boolean"},
    "isReminderOn": {"type": "boolean"},
    "reminderMinutesBeforeStart": {"type": "integer", "minimum": 0, "maximum": 40320},
    "importance": {"type": "string", "enum": ["low", "normal", "high"]},
    "sensitivity": {"type": "string", "enum": ["normal", "personal", "private", "confidential"]},
    "showAs": {"type": "string", "enum": ["free", "tentative", "busy", "oof", "workingElsewhere", "unknown"]},
}
CREATE_CALENDAR_EVENT_BODY_SCHEMA = {
    "type": "object",
    "properties": CALENDAR_EVENT_PROPERTIES,
    "required": ["subject", "start", "end"],
    "additionalProperties": False,
}
UPDATE_CALENDAR_EVENT_BODY_SCHEMA = {
    "type": "object",
    "properties": CALENDAR_EVENT_PROPERTIES,
    "minProperties": 1,
    "additionalProperties": False,
}
CURATED_WRITE_INPUT_SCHEMAS = {
    "create-draft-email": {
        "type": "object", "properties": {"body": MAIL_MESSAGE_SCHEMA},
        "required": ["body"], "additionalProperties": False,
    },
    "update-mail-message": {
        "type": "object", "properties": {"messageId": {"type": "string"}, "body": MAIL_PATCH_SCHEMA},
        "required": ["messageId", "body"], "additionalProperties": False,
    },
    "move-mail-message": {
        "type": "object",
        "properties": {
            "messageId": {"type": "string"},
            "body": {
                "type": "object", "properties": {"DestinationId": {"type": "string"}},
                "required": ["DestinationId"], "additionalProperties": False,
            },
        },
        "required": ["messageId", "body"], "additionalProperties": False,
    },
    "send-mail": {
        "type": "object",
        "properties": {
            "body": {
                "type": "object",
                "properties": {
                    "Message": {
                        **MAIL_MESSAGE_SCHEMA,
                        "required": ["subject", "body", "toRecipients"],
                    },
                    "SaveToSentItems": {"type": "boolean"},
                },
                "required": ["Message"],
                "additionalProperties": False,
            },
        },
        "required": ["body"], "additionalProperties": False,
    },
    "reply-mail-message": {
        "type": "object",
        "properties": {
            "messageId": {"type": "string"},
            "body": {
                "type": "object", "properties": {"Comment": {"type": "string", "minLength": 1, "maxLength": 100000}},
                "required": ["Comment"], "additionalProperties": False,
            },
        },
        "required": ["messageId", "body"], "additionalProperties": False,
    },
    "reply-all-mail-message": {
        "type": "object",
        "properties": {
            "messageId": {"type": "string"},
            "body": {
                "type": "object", "properties": {"Comment": {"type": "string", "minLength": 1, "maxLength": 100000}},
                "required": ["Comment"], "additionalProperties": False,
            },
        },
        "required": ["messageId", "body"], "additionalProperties": False,
    },
    "forward-mail-message": {
        "type": "object",
        "properties": {
            "messageId": {"type": "string"},
            "body": {
                "type": "object",
                "properties": {
                    "ToRecipients": RECIPIENTS_SCHEMA,
                    "Comment": {"type": "string", "maxLength": 100000},
                },
                "required": ["ToRecipients"],
                "additionalProperties": False,
            },
        },
        "required": ["messageId", "body"], "additionalProperties": False,
    },
    "create-calendar-event": {
        "type": "object", "properties": {"body": CREATE_CALENDAR_EVENT_BODY_SCHEMA},
        "required": ["body"], "additionalProperties": False,
    },
    "update-calendar-event": {
        "type": "object",
        "properties": {"eventId": {"type": "string"}, "body": UPDATE_CALENDAR_EVENT_BODY_SCHEMA},
        "required": ["eventId", "body"], "additionalProperties": False,
    },
    "create-onedrive-folder": {
        "type": "object",
        "properties": {
            "driveId": {"type": "string"},
            "driveItemId": {"type": "string"},
            "body": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 255},
                    "folder": {"type": "object", "properties": {}, "additionalProperties": False},
                    "@microsoft.graph.conflictBehavior": {"type": "string", "enum": ["fail", "replace", "rename"]},
                },
                "required": ["name", "folder"],
                "additionalProperties": False,
            },
        },
        "required": ["driveId", "driveItemId", "body"], "additionalProperties": False,
    },
    "move-rename-onedrive-item": {
        "type": "object",
        "properties": {
            "driveId": {"type": "string"},
            "driveItemId": {"type": "string"},
            "body": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 255},
                    "parentReference": {
                        "type": "object", "properties": {"id": {"type": "string"}},
                        "required": ["id"], "additionalProperties": False,
                    },
                },
                "minProperties": 1,
                "additionalProperties": False,
            },
        },
        "required": ["driveId", "driveItemId", "body"], "additionalProperties": False,
    },
    "copy-drive-item": {
        "type": "object",
        "properties": {
            "driveId": {"type": "string"},
            "driveItemId": {"type": "string"},
            "body": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "maxLength": 255},
                    "parentReference": {
                        "type": "object",
                        "properties": {"driveId": {"type": "string"}, "id": {"type": "string"}},
                        "required": ["id"],
                        "additionalProperties": False,
                    },
                },
                "required": ["parentReference"],
                "additionalProperties": False,
            },
        },
        "required": ["driveId", "driveItemId", "body"], "additionalProperties": False,
    },
    **TEAMS_INPUT_SCHEMAS,
}
CURATED_WRITE_DESCRIPTIONS = {
    "create-draft-email": "Create an Outlook email draft without sending it. Body is a message object with subject, body, and optional recipients. ONEComputer obtains signed approval before creating the draft.",
    "update-mail-message": "Update editable fields on an existing Outlook message or draft. Get messageId from list-mail-messages. Supply only the fields to change. ONEComputer obtains signed approval.",
    "delete-mail-message": "Delete one Outlook message. Get messageId from list-mail-messages or get-mail-message. ONEComputer obtains signed approval before deleting.",
    "move-mail-message": "Move one Outlook message to another mail folder. Get messageId from list-mail-messages and DestinationId from list-mail-folders. ONEComputer obtains signed approval.",
    "send-mail": "Send a new Outlook email. Body must contain Message with subject, body, and verified toRecipients; optionally set SaveToSentItems. Never guess a recipient address. ONEComputer obtains signed approval before sending.",
    "send-draft-message": "Send an existing Outlook draft. Get messageId from list-mail-messages and verify the draft and recipients first. ONEComputer obtains signed approval before sending.",
    "reply-mail-message": "Reply only to the sender of an Outlook message. Get messageId from get-mail-message and put the reply text in body.Comment. ONEComputer obtains signed approval before sending.",
    "reply-all-mail-message": "Reply to the sender and all recipients of an Outlook message. Verify the recipient set, then put the reply text in body.Comment. ONEComputer obtains signed approval before sending.",
    "forward-mail-message": "Forward an Outlook message to explicitly verified recipients. Put them in body.ToRecipients and optional text in body.Comment. Never guess an address. ONEComputer obtains signed approval before sending.",
    "create-calendar-event": "Create an Outlook calendar event. Supply subject plus start and end objects containing local dateTime and an explicit Windows timeZone. Add attendees only when the user requested them. ONEComputer applies the configured write policy.",
    "update-calendar-event": "Update an existing Outlook calendar event. Get eventId from get-calendar-view or list-calendar-events and supply only the fields to change. ONEComputer obtains signed approval.",
    "delete-calendar-event": "Delete one Outlook calendar event. Resolve the exact eventId and confirm ambiguous matches before calling. ONEComputer obtains signed approval.",
    "create-onedrive-folder": "Create a folder below a OneDrive item. Use list-drives and list-folder-files to resolve driveId and parent driveItemId. Body requires name and folder: {}. ONEComputer obtains signed approval.",
    "move-rename-onedrive-item": "Rename and/or move one OneDrive item. Resolve driveId and driveItemId first; body may contain name and/or parentReference.id. ONEComputer obtains signed approval.",
    "copy-drive-item": "Copy one OneDrive item. Resolve the source driveId and driveItemId; body requires parentReference.id and may include a new name. ONEComputer obtains signed approval.",
    **TEAMS_TOOL_DESCRIPTIONS,
}


def request_json(path: str, body: dict | None = None) -> dict:
    request = urllib.request.Request(
        f"{BROKER}{path}",
        data=None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="GET" if body is None else "POST",
        headers={} if body is None else {"content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=70) as response:
        return json.load(response)


def operation_id(value: object) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("operation_id")
        if isinstance(candidate, str):
            return candidate
        for child in value.values():
            found = operation_id(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = operation_id(child)
            if found:
                return found
    return None


def omit_nulls(value: object) -> object:
    """Remove null optional fields emitted by upstream MCP adapters.

    MCP result metadata, annotations, and structuredContent are optional
    objects, not nullable values. Some gateway REST projections serialize
    absent fields as null; strict Desktop clients discard those responses and
    eventually report a misleading tool timeout.
    """
    if isinstance(value, dict):
        return {key: omit_nulls(child) for key, child in value.items() if child is not None}
    if isinstance(value, list):
        return [omit_nulls(child) for child in value]
    return value


def normalize_graph_etag(value: str) -> str:
    """Restore the HTTP quoting Graph requires around a drive-item eTag.

    Models sometimes preserve the opaque version value while dropping the
    outer quotes shown in the JSON result. Only normalize the documented
    Graph drive-item shape; leave every other value unchanged so Microsoft can
    reject malformed or unsupported validators.
    """
    candidate = value.strip()
    if ((candidate.startswith('"') and candidate.endswith('"'))
            or (candidate.startswith('W/"') and candidate.endswith('"'))):
        return candidate
    if candidate.startswith("{") and "}," in candidate:
        return f'"{candidate}"'
    return candidate


def normalize_upload_drive_item_id(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("driveItemId is required")
    candidate = value.strip()
    # Softeria previously advertised its complete Graph path fragment as the
    # value for driveItemId. That unambiguous legacy form would otherwise be
    # inserted into the endpoint a second time as /items/<value>/content.
    for prefix in ("/items/", "items/"):
        if candidate.startswith(prefix) and candidate.endswith("/content"):
            candidate = candidate[len(prefix):-len("/content")]
            break
    if candidate.startswith(("http://", "https://", "/drives/", "drives/", "/items/", "items/")):
        raise ValueError("driveItemId must not contain a Graph URL or endpoint wrapper")
    if candidate.startswith("root:/") and not candidate.endswith(":"):
        candidate = f"{candidate}:"
    if not candidate or candidate.endswith("/content"):
        raise ValueError("driveItemId is not an item ID or drive-relative path selector")
    return candidate


def validate_upload_body(value: object) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError("body must contain base64-encoded file bytes")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("body must be valid base64-encoded file bytes") from error
    if len(decoded) > 4 * 1024 * 1024:
        raise ValueError("upload-file-content supports at most 4 MB of decoded file bytes")


def discover_tools() -> list[dict]:
    response = request_json("/mcp-rest/tools/list")
    tools = response.get("tools", [])
    if not isinstance(tools, list):
        raise RuntimeError("gateway returned an invalid tool list")
    result = []
    TOOLS.clear()
    for raw in tools:
        if not isinstance(raw, dict) or not isinstance(raw.get("name"), str):
            continue
        TOOLS[raw["name"]] = raw
        input_schema = raw.get("inputSchema", raw.get("input_schema", {"type": "object"}))
        if raw["name"] == "list-drives":
            input_schema = LIST_DRIVES_INPUT_SCHEMA
        elif raw["name"] == "search-onedrive-files":
            input_schema = SEARCH_ONEDRIVE_INPUT_SCHEMA
        elif raw["name"] == "upload-file-content":
            input_schema = UPLOAD_ONEDRIVE_INPUT_SCHEMA
        elif raw["name"] == "list-joined-teams":
            input_schema = NO_ARGUMENTS_INPUT_SCHEMA
        elif raw["name"] in CURATED_WRITE_INPUT_SCHEMAS:
            input_schema = CURATED_WRITE_INPUT_SCHEMAS[raw["name"]]
        if raw["name"] in WRITE_TOOLS and isinstance(input_schema, dict):
            # Connector execution flags are Control-owned. Do not advertise
            # them as agent inputs; Control adds them only after approval.
            input_schema = json.loads(json.dumps(input_schema))
            properties = input_schema.get("properties")
            if isinstance(properties, dict):
                properties.pop("confirm", None)
                properties.pop("excludeResponse", None)
                properties.pop("includeHeaders", None)
            required = input_schema.get("required")
            if isinstance(required, list):
                required = [item for item in required if item not in {"confirm", "excludeResponse", "includeHeaders"}]
                if raw["name"] == "delete-onedrive-file":
                    required = list(dict.fromkeys(required + ["If-Match"]))
                input_schema["required"] = required
            input_schema["additionalProperties"] = False
        result.append({
            "name": raw["name"],
            "description": (
                DELETE_ONEDRIVE_DESCRIPTION if raw["name"] == "delete-onedrive-file"
                else CALENDAR_VIEW_DESCRIPTION if raw["name"] == "get-calendar-view"
                else LIST_DRIVES_DESCRIPTION if raw["name"] == "list-drives"
                else SEARCH_ONEDRIVE_DESCRIPTION if raw["name"] == "search-onedrive-files"
                else UPLOAD_ONEDRIVE_DESCRIPTION if raw["name"] == "upload-file-content"
                else LIST_JOINED_TEAMS_DESCRIPTION if raw["name"] == "list-joined-teams"
                else CURATED_WRITE_DESCRIPTIONS[raw["name"]] if raw["name"] in CURATED_WRITE_DESCRIPTIONS
                else raw.get("description", "Microsoft 365 tool governed by ONEComputer policy.")
            ),
            "inputSchema": input_schema,
        })
    TOOLS[WAIT_TOOL_NAME] = {"name": WAIT_TOOL_NAME, "onecomputer_local": True}
    result.append({
        "name": WAIT_TOOL_NAME,
        "description": "Wait for a protected ONEComputer operation after another Microsoft 365 tool reports that signed approval is pending. Waits for up to 75 seconds. If the operation is still pending, call this tool again with the same operationId. Do not retry the original destructive tool.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operationId": {
                    "type": "string",
                    "description": "The ONEComputer governed operation ID returned by the protected tool.",
                },
            },
            "required": ["operationId"],
            "additionalProperties": False,
        },
    })
    return result


def wait_for_operation(identifier: str, timeout_seconds: int = 75) -> dict:
    deadline = time.monotonic() + timeout_seconds
    operation: dict = {"id": identifier, "state": "approval_required"}
    while time.monotonic() < deadline:
        operation = request_json(f"/onecomputer/operations/{identifier}")
        state = operation.get("state")
        if state in {"succeeded", "denied", "failed", "expired"}:
            return operation
        time.sleep(1)
    return operation


def operation_result(operation: dict, identifier: str) -> dict:
    if operation.get("state") == "succeeded":
        receipt = operation.get("receipt") if isinstance(operation.get("receipt"), dict) else {}
        summary = receipt.get("resultSummary") or f"{operation.get('safeSummary', 'The governed action')} completed after approval."
        return {
            "content": [{"type": "text", "text": str(summary)}],
            "isError": False,
            "_meta": {"onecomputer": {"operationId": identifier, "state": "succeeded", "approval": "openvtc-task-consent"}},
        }
    state = operation.get("state", "failed")
    if state in {"approval_required", "approved", "executing"}:
        return {
            "content": [{"type": "text", "text": f"The signed approval for operation {identifier} is still pending or being executed. The protected action has not returned a final result. Call {WAIT_TOOL_NAME} again with this same operationId; do not retry the original destructive tool."}],
            "isError": False,
            "_meta": {"onecomputer": {"operationId": identifier, "state": state, "approval": "openvtc-task-consent"}},
        }
    if state == "failed" and isinstance(operation.get("approval"), dict) and operation["approval"].get("decision") == "approve":
        failure_code = operation.get("failureCode") or "TOOL_EXECUTION_FAILED"
        failure_summary = operation.get("failureSummary")
        detail = str(failure_summary) if failure_summary else f"failure code {failure_code}"
        return error_result(
            f"The signed approval for operation {identifier} succeeded, but the Microsoft 365 execution failed after dispatch: {detail}. "
            "The requested change did not complete. Do not describe this result as rejected, denied, or not approved.",
            identifier,
            state,
        )
    return error_result(f"The governed action was {state}. No further tool execution occurred.", identifier, state)


def call_tool(name: str, arguments: dict) -> dict:
    selected = TOOLS.get(name)
    if selected is None:
        discover_tools()
        selected = TOOLS.get(name)
    if name == WAIT_TOOL_NAME:
        identifier = arguments.get("operationId")
        if not isinstance(identifier, str) or not identifier:
            return error_result("A governed operationId is required.")
        return operation_result(wait_for_operation(identifier), identifier)
    server_id = (selected or {}).get("mcp_info", {}).get("server_id")
    if not isinstance(server_id, str):
        return error_result("That tool is not assigned to this workspace.")
    if name in WRITE_TOOLS:
        # Connector execution flags are never accepted from the model. The
        # managed bridge supplies Softeria's confirmation flag, while Control
        # independently decides whether the action is allowed, held for signed
        # approval, or denied before the connector can execute it.
        arguments = {key: value for key, value in arguments.items() if key not in {"confirm", "excludeResponse", "includeHeaders"}}
        arguments["confirm"] = True
    if name == "upload-file-content":
        try:
            arguments["driveItemId"] = normalize_upload_drive_item_id(arguments.get("driveItemId"))
            validate_upload_body(arguments.get("body"))
        except ValueError as error:
            return error_result(
                f"The OneDrive upload was not submitted: {error}. "
                "Use an opaque item ID, root:/file.txt:, or root:/folder/file.txt: as driveItemId."
            )
    if name == "delete-onedrive-file":
        if not isinstance(arguments.get("If-Match"), str) or not arguments["If-Match"].strip():
            return error_result(DELETE_ONEDRIVE_MISSING_ETAG)
        arguments["If-Match"] = normalize_graph_etag(arguments["If-Match"])
    try:
        response = request_json("/mcp-rest/tools/call", {
            "server_id": server_id,
            "name": name,
            "arguments": arguments,
        })
        if not isinstance(response.get("content"), list):
            return error_result("The Microsoft 365 connector returned an invalid tool result.")
        return omit_nulls(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
        identifier = operation_id(payload)
        if error.code != 409 or not identifier:
            message = nested_error(payload) or f"ONEComputer rejected the tool call (HTTP {error.code})."
            return error_result(message)

    return {
        "content": [{"type": "text", "text": f"Signed approval is required for operation {identifier}. The action has not run. Call {WAIT_TOOL_NAME} now with this operationId and keep calling it while approval remains pending. Do not retry the original destructive tool."}],
        "isError": False,
        "_meta": {"onecomputer": {"operationId": identifier, "state": "approval_required", "approval": "openvtc-task-consent"}},
    }


def nested_error(value: object) -> str | None:
    if isinstance(value, dict):
        candidate = value.get("error")
        if isinstance(candidate, str):
            return candidate
        for child in value.values():
            found = nested_error(child)
            if found:
                return found
    return None


def error_result(message: str, identifier: str | None = None, state: str | None = None) -> dict:
    result = {"content": [{"type": "text", "text": message}], "isError": True}
    if identifier:
        result["_meta"] = {"onecomputer": {"operationId": identifier, "state": state}}
    return result


def respond(identifier: object, result: dict | None = None, error: dict | None = None) -> None:
    document = {"jsonrpc": "2.0", "id": identifier}
    document["result" if error is None else "error"] = result if error is None else error
    with RESPONSE_LOCK:
        print(json.dumps(document, separators=(",", ":")), flush=True)


def execute_tool_call(identifier: object, name: str, arguments: dict) -> None:
    try:
        respond(identifier, call_tool(name, arguments))
    except Exception as error:  # Tool failures must not terminate the managed connector.
        print(f"onecomputer-mcp: {type(error).__name__}", file=sys.stderr, flush=True)
        respond(identifier, error={
            "code": -32603,
            "message": "The governed Microsoft 365 connector is unavailable.",
        })


def handle(message: dict) -> None:
    method = message.get("method")
    identifier = message.get("id")
    if identifier is None:
        return
    try:
        if method == "initialize":
            respond(identifier, {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "onecomputer-microsoft-365", "version": "0.1.0"},
                "instructions": "Microsoft 365 tools operate on remote Outlook Mail, Calendar, OneDrive, and Teams resources. Use the corresponding MCP tool directly. Read calls normally run immediately. Writes may return a governed operation; call wait-for-governed-operation with that operationId until signed approval or denial is final. Never substitute Cowork or local-filesystem permission tools. ONEComputer Control enforces policy and obtains signed approval inside protected tool calls.",
            })
        elif method == "ping":
            respond(identifier, {})
        elif method == "tools/list":
            respond(identifier, {"tools": discover_tools()})
        elif method == "tools/call":
            params = message.get("params", {})
            name = params.get("name")
            arguments = params.get("arguments", {})
            if not isinstance(name, str) or not isinstance(arguments, dict):
                raise ValueError("invalid tool call")
            # A governed operation may wait for a human decision. Keep the
            # JSON-RPC input loop available for MCP pings while that call is
            # pending; otherwise Hermes declares the healthy stdio bridge dead
            # and orphans the operation before its approved result can return.
            threading.Thread(
                target=execute_tool_call,
                args=(identifier, name, arguments),
                daemon=True,
                name=f"onecomputer-mcp-call-{identifier}",
            ).start()
        else:
            respond(identifier, error={"code": -32601, "message": "Method not found"})
    except Exception as error:  # MCP must report failures without terminating the managed connector.
        print(f"onecomputer-mcp: {type(error).__name__}", file=sys.stderr, flush=True)
        respond(identifier, error={"code": -32603, "message": "The governed Microsoft 365 connector is unavailable."})


for line in sys.stdin:
    try:
        message = json.loads(line)
        if isinstance(message, dict):
            handle(message)
    except json.JSONDecodeError:
        print("onecomputer-mcp: ignored malformed input", file=sys.stderr, flush=True)
