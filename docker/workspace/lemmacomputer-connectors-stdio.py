#!/usr/bin/env python3
"""Credentialless aggregate MCP bridge for agents inside a managed workspace."""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid


BROKER = os.environ.get("LEMMACOMPUTER_CONNECTORS_BROKER", "http://127.0.0.1:4312")
if BROKER not in {
    "http://127.0.0.1:4312",
    "http://127.0.0.1:4314",
    "http://127.0.0.1:4315",
    "http://127.0.0.1:4316",
    "http://127.0.0.1:4317",
}:
    raise SystemExit("invalid LemmaComputer connectors broker")
PROTOCOL_VERSION = "2024-11-05"
TOOLS: dict[str, dict] = {}
LOCAL_UPLOADS: dict[str, dict] = {}
RESPONSE_LOCK = threading.Lock()
TOOL_MONITOR_LOCK = threading.Lock()
TOOL_MONITOR_STARTED = False
TOOL_REFRESH_LOCK = threading.Lock()
TOOL_LIST_READY = False
TOOL_REFRESH_NEXT_AT = 0.0
TOOL_REFRESH_RETRY_SECONDS = 0.0
TOOL_RECOVERY_STARTED_AT: float | None = None
TOOL_RECOVERY_EXHAUSTED = False
CONNECTOR_RECOVERY_STATE_FILE = os.environ.get("LEMMACOMPUTER_CONNECTOR_RECOVERY_STATE_FILE", "").strip()
try:
    CONNECTOR_RECOVERY_DEADLINE_SECONDS = float(
        os.environ.get("LEMMACOMPUTER_CONNECTOR_RECOVERY_DEADLINE_SECONDS", "60")
    )
except ValueError:
    CONNECTOR_RECOVERY_DEADLINE_SECONDS = 60.0
CONNECTOR_RECOVERY_DEADLINE_SECONDS = min(300.0, max(0.1, CONNECTOR_RECOVERY_DEADLINE_SECONDS))
WAIT_TOOL_NAME = "wait-for-governed-operation"
LOCAL_UPLOAD_ROOT = os.path.realpath(os.path.expanduser("~"))
MAX_INLINE_UPLOAD_BYTES = 4 * 1024 * 1024
WRITE_TOOLS = {
    "create-draft-email", "update-mail-message", "delete-mail-message", "move-mail-message",
    "send-mail", "send-draft-message", "reply-mail-message", "reply-all-mail-message", "forward-mail-message",
    "create-calendar-event", "update-calendar-event", "delete-calendar-event", "create-onedrive-folder",
    "upload-file-content", "move-rename-onedrive-item", "copy-drive-item", "delete-onedrive-file",
    "send-chat-message", "reply-to-chat-message", "send-channel-message", "reply-to-channel-message",
}
AUDIT_CONTEXT_SCHEMA = {
    "type": "object",
    "properties": {
        "target": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512,
            "description": "Exact human-facing recipient, chat, file, folder, event, message, channel, item, or destination selected for this action.",
        },
        "targetType": {
            "type": "string",
            "enum": ["recipient", "chat", "channel", "file", "folder", "event", "message", "item", "destination"],
        },
    },
    "required": ["target", "targetType"],
    "additionalProperties": False,
}
DELETE_ONEDRIVE_DESCRIPTION = """Delete one Microsoft OneDrive or SharePoint drive item through LemmaComputer governance.

This is a remote Microsoft 365 action, not a local filesystem action. A user-facing filename, link, folder path, or filename visible in an attached screenshot is enough to begin discovery: call list-drives to resolve driveId, then search-onedrive-files or list-folder-files to resolve the exact driveItemId. Do not ask the user for internal drive or item IDs before attempting those assigned discovery tools. If multiple items match, ask the user to disambiguate before deleting anything.

Before calling this tool, get the exact item's current top-level name and eTag with get-drive-item (includeHeaders=true and select=id,name,eTag,parentReference). Pass that exact name as resourceName and exact eTag as If-Match. The resourceName is shown to the user in the signed approval and Trail; never substitute an opaque item ID. Call this tool directly; do not request Cowork or local-file deletion permission. LemmaComputer Control will obtain any required signed approval and this call will wait for the final result."""
DELETE_ONEDRIVE_MISSING_METADATA = """The remote OneDrive deletion was not submitted because resourceName or If-Match is missing. Call get-drive-item for this driveId and driveItemId with includeHeaders=true and select=id,name,eTag,parentReference, then call delete-onedrive-file again with the exact top-level name as resourceName and eTag as If-Match. Do not use Cowork or local-filesystem deletion permission; LemmaComputer handles approval when this remote tool is called."""
CALENDAR_VIEW_DESCRIPTION = """Get chronological event occurrences from the signed-in user's default Outlook calendar within an explicit time window.

Use this tool for requests such as next, upcoming, today, this week, or events between two dates. For upcoming events, set startDateTime to the current time and endDateTime to a bounded future time in ISO 8601 format. Do not use list-calendar-events for upcoming events because that tool returns event series without an implicit from-now window."""
LIST_DRIVES_DESCRIPTION = """List the signed-in user's available OneDrive and SharePoint drives.

Use this first when a OneDrive request supplies a human-facing filename, link, or path but no driveId. Omit top or set it to at least 2: Microsoft Graph can return an empty first page plus a next link when top is 1. Continue with search-onedrive-files or list-folder-files; do not ask the user to provide an internal drive ID before attempting this discovery."""
SEARCH_ONEDRIVE_DESCRIPTION = """Search one OneDrive or SharePoint drive for items matching a human-facing filename.

If driveId is unknown, call list-drives first. Search using the filename or other value the user supplied, including a filename visible in an attached screenshot. Use top no greater than 10 and the exact select value id,name,eTag,parentReference. Do not request all pages. OneDrive search is eventually consistent, so use list-folder-files on the known parent immediately after creating an item. Treat multiple matches as ambiguous and ask the user to choose before a mutation."""
UPLOAD_ONEDRIVE_DESCRIPTION = """Create or replace one file in Microsoft OneDrive or SharePoint through LemmaComputer governance.

Pass driveId from list-drives. Pass only the value that belongs between `/items/` and `/content` as driveItemId: use an opaque item ID to replace an existing file, `root:/file.txt:` for a new file in the drive root, or `root:/folder/file.txt:` for a new file below the root. Never include `/items/`, `/content`, `/drives/`, or a complete Microsoft Graph URL in driveItemId. For a file already in this workspace, pass its absolute path as localFilePath; LemmaComputer uses an approval-bound resumable upload and streams bounded chunks without putting file bytes into model text or imposing a product file-size limit. Otherwise pass a small base64-encoded body supported by the connector's inline endpoint. Supply exactly one of localFilePath or body. To verify a just-created file, call list-folder-files on its parent because OneDrive search indexing can lag. Call this tool directly; LemmaComputer obtains any required signed approval."""
LIST_JOINED_TEAMS_DESCRIPTION = """List every Microsoft Teams team joined by the signed-in user.

This Graph endpoint does not accept generic OData paging or filtering options. Call it with no arguments, then match the returned displayName and id locally. Use the selected id with list-team-channels."""
TEAMS_TOOL_DESCRIPTIONS = {
    "send-chat-message": "Send one HTML message to an existing Teams chat. Get chatId from list-chats. Put the message in body.body.content and set body.body.contentType to html. Set lemmacomputerAudit to the exact human-facing recipient or conversation selected during discovery with targetType chat. LemmaComputer obtains signed approval before sending.",
    "reply-to-chat-message": "Reply with one HTML message to an existing Teams chat message. Get chatId from list-chats and chatMessageId from list-chat-messages. Put the reply in body.body.content and set body.body.contentType to html. Set lemmacomputerAudit to the exact human-facing recipient or conversation with targetType chat. LemmaComputer obtains signed approval before sending.",
    "send-channel-message": "Post one HTML message to a Teams channel. Get teamId from list-joined-teams and channelId from list-team-channels. Put the post in body.body.content and set body.body.contentType to html. Set lemmacomputerAudit to the exact team and channel display names selected during discovery. LemmaComputer obtains signed approval before posting.",
    "reply-to-channel-message": "Reply with one HTML message to a Teams channel post. Get teamId from list-joined-teams, channelId from list-team-channels, and the parent chatMessageId from list-channel-messages. Set lemmacomputerAudit to the exact team and channel display names. Put the reply in body.body.content and set body.body.contentType to html. LemmaComputer obtains signed approval before posting.",
}

BOUNDED_LIST_INPUT_PROPERTIES = {
    "top": {"type": "integer", "minimum": 1, "maximum": 25},
}
CALENDAR_VIEW_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        **BOUNDED_LIST_INPUT_PROPERTIES,
        "startDateTime": {"type": "string", "format": "date-time", "description": "ISO 8601 date-time with UTC or a numeric offset, for example 2026-07-29T00:00:00+08:00."},
        "endDateTime": {"type": "string", "format": "date-time", "description": "ISO 8601 date-time with UTC or a numeric offset, no more than 93 days after startDateTime."},
        "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
    },
    "required": ["startDateTime", "endDateTime"],
    "additionalProperties": False,
}
LIST_CALENDAR_EVENTS_INPUT_SCHEMA = {
    "type": "object",
    "properties": {**BOUNDED_LIST_INPUT_PROPERTIES, "timezone": {"type": "string", "minLength": 1, "maxLength": 64}},
    "additionalProperties": False,
}

LIST_DRIVES_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "top": {"type": "integer", "minimum": 2, "maximum": 25},
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
            "description": "Base64-encoded file bytes, not plain text. Do not use this when localFilePath is available.",
        },
        "localFilePath": {
            "type": "string",
            "minLength": 1,
            "maxLength": 4096,
            "description": "Absolute path to an existing regular file inside this workspace, for example /home/kasm-user/report.pptx. This uses an approval-bound resumable upload with no product file-size limit. Prefer it for workspace files; do not read or base64-encode the file yourself.",
        },
    },
    "required": ["driveId", "driveItemId"],
    "oneOf": [
        {"required": ["body"]},
        {"required": ["localFilePath"]},
    ],
    "additionalProperties": False,
}
DELETE_ONEDRIVE_INPUT_SCHEMA = {
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
            "maxLength": 512,
            "description": "Opaque item ID returned by get-drive-item.",
        },
        "resourceName": {
            "type": "string",
            "minLength": 1,
            "maxLength": 255,
            "description": "Exact top-level name returned by get-drive-item. LemmaComputer shows this human-facing target in the signed approval and Trail.",
        },
        "If-Match": {
            "type": "string",
            "minLength": 1,
            "maxLength": 512,
            "description": "Exact top-level eTag returned by get-drive-item.",
        },
    },
    "required": ["driveId", "driveItemId", "resourceName", "If-Match"],
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
    "delete-mail-message": {
        "type": "object",
        "properties": {
            "messageId": {"type": "string", "minLength": 1, "maxLength": 512},
            "If-Match": {"type": "string", "minLength": 1, "maxLength": 512},
        },
        "required": ["messageId"], "additionalProperties": False,
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
    "send-draft-message": {
        "type": "object",
        "properties": {"messageId": {"type": "string", "minLength": 1, "maxLength": 512}},
        "required": ["messageId"], "additionalProperties": False,
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
    "delete-calendar-event": {
        "type": "object",
        "properties": {
            "eventId": {"type": "string", "minLength": 1, "maxLength": 512},
            "If-Match": {"type": "string", "minLength": 1, "maxLength": 512},
        },
        "required": ["eventId"], "additionalProperties": False,
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
    "create-draft-email": "Create an Outlook email draft without sending it. Body is a message object with subject, body, and optional recipients. LemmaComputer obtains signed approval before creating the draft.",
    "update-mail-message": "Update editable fields on an existing Outlook message or draft. Get messageId from list-mail-messages. Supply only the fields to change. LemmaComputer obtains signed approval.",
    "delete-mail-message": "Delete one Outlook message. Get messageId from list-mail-messages or get-mail-message. LemmaComputer obtains signed approval before deleting.",
    "move-mail-message": "Move one Outlook message to another mail folder. Get messageId from list-mail-messages and DestinationId from list-mail-folders. LemmaComputer obtains signed approval.",
    "send-mail": "Send a new Outlook email. Body must contain Message with subject, body, and verified toRecipients; optionally set SaveToSentItems. Never guess a recipient address. LemmaComputer obtains signed approval before sending.",
    "send-draft-message": "Send an existing Outlook draft. Get messageId from list-mail-messages and verify the draft and recipients first. LemmaComputer obtains signed approval before sending.",
    "reply-mail-message": "Reply only to the sender of an Outlook message. Get messageId from get-mail-message and put the reply text in body.Comment. LemmaComputer obtains signed approval before sending.",
    "reply-all-mail-message": "Reply to the sender and all recipients of an Outlook message. Verify the recipient set, then put the reply text in body.Comment. LemmaComputer obtains signed approval before sending.",
    "forward-mail-message": "Forward an Outlook message to explicitly verified recipients. Put them in body.ToRecipients and optional text in body.Comment. Never guess an address. LemmaComputer obtains signed approval before sending.",
    "create-calendar-event": "Create an Outlook calendar event. Supply subject plus start and end objects containing local dateTime and an explicit timeZone supported by the employee's mailbox. Use the trusted employee timezone supplied in the agent instructions when the request omits a timezone; if none is supplied, ask before calling this tool. Never guess from examples or substitute Pacific time. Add attendees only when the user requested them. LemmaComputer applies the configured write policy.",
    "update-calendar-event": "Update an existing Outlook calendar event. Get eventId from get-calendar-view or list-calendar-events and supply only the fields to change. LemmaComputer obtains signed approval.",
    "delete-calendar-event": "Delete one Outlook calendar event. Resolve the exact eventId and confirm ambiguous matches before calling. LemmaComputer obtains signed approval.",
    "create-onedrive-folder": "Create a folder below a OneDrive item. Use list-drives and list-folder-files to resolve driveId and parent driveItemId. Body requires name and folder: {}. LemmaComputer obtains signed approval.",
    "move-rename-onedrive-item": "Rename and/or move one OneDrive item. Resolve driveId and driveItemId first; body may contain name and/or parentReference.id. LemmaComputer obtains signed approval.",
    "copy-drive-item": "Copy one OneDrive item. Resolve the source driveId and driveItemId; body requires parentReference.id and may include a new name. LemmaComputer obtains signed approval.",
    **TEAMS_TOOL_DESCRIPTIONS,
}

MS365_CONTRACT_VERSION = 1
OPAQUE_ID = {"type": "string", "minLength": 1, "maxLength": 512}


def strict_input(properties: dict | None = None, required: list[str] | None = None) -> dict:
    return {
        "type": "object",
        "properties": properties or {},
        **({"required": required} if required else {}),
        "additionalProperties": False,
    }


def identified_input(*identifiers: str, extra: dict | None = None) -> dict:
    properties = {
        identifier: {
            **OPAQUE_ID,
            "description": f"Opaque {identifier} returned by the corresponding Microsoft 365 discovery tool.",
        }
        for identifier in identifiers
    }
    properties.update(extra or {})
    return strict_input(properties, list(identifiers))


MS365_READ_INPUT_SCHEMAS = {
    "list-mail-folders": strict_input(dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "list-mail-messages": strict_input(dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "get-mail-message": identified_input("messageId"),
    "list-calendars": strict_input(dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "list-calendar-events": LIST_CALENDAR_EVENTS_INPUT_SCHEMA,
    "get-calendar-view": CALENDAR_VIEW_INPUT_SCHEMA,
    "get-calendar-event": identified_input("eventId", extra={
        "timezone": {"type": "string", "minLength": 1, "maxLength": 64},
    }),
    "list-drives": LIST_DRIVES_INPUT_SCHEMA,
    "get-drive-root-item": identified_input("driveId"),
    "list-folder-files": identified_input("driveId", "driveItemId", extra=dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "search-onedrive-files": SEARCH_ONEDRIVE_INPUT_SCHEMA,
    "get-drive-item": strict_input({
        "driveId": OPAQUE_ID,
        "driveItemId": OPAQUE_ID,
        "includeHeaders": {"type": "boolean", "const": True},
        "select": {"type": "string", "const": "id,name,eTag,parentReference"},
    }, ["driveId", "driveItemId", "includeHeaders", "select"]),
    "list-chats": strict_input(dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "list-chat-messages": identified_input("chatId", extra=dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "list-joined-teams": NO_ARGUMENTS_INPUT_SCHEMA,
    "list-team-channels": identified_input("teamId", extra=dict(BOUNDED_LIST_INPUT_PROPERTIES)),
    "list-channel-messages": identified_input("teamId", "channelId", extra=dict(BOUNDED_LIST_INPUT_PROPERTIES)),
}

MS365_WRITE_INPUT_SCHEMAS = {
    **CURATED_WRITE_INPUT_SCHEMAS,
    "upload-file-content": UPLOAD_ONEDRIVE_INPUT_SCHEMA,
    "delete-onedrive-file": DELETE_ONEDRIVE_INPUT_SCHEMA,
}

MS365_INPUT_SCHEMAS = {**MS365_READ_INPUT_SCHEMAS, **MS365_WRITE_INPUT_SCHEMAS}

MS365_READ_DESCRIPTIONS = {
    "list-mail-folders": "List Outlook mail folders. Use a returned folder id when a later mail action requires one. top is the only qualified paging control.",
    "list-mail-messages": "List recent Outlook messages. Use a returned message id with get-mail-message before replying, forwarding, moving, or deleting. Raw Graph filter and search expressions are not supported.",
    "get-mail-message": "Read one Outlook message by the opaque messageId returned by list-mail-messages.",
    "list-calendars": "List the signed-in user's Outlook calendars. Use get-calendar-view for occurrences in a time window.",
    "list-calendar-events": "List Outlook calendar event series. This does not expand recurring occurrences; use get-calendar-view for today or upcoming events.",
    "get-calendar-view": CALENDAR_VIEW_DESCRIPTION,
    "get-calendar-event": "Read one Outlook event by eventId. timezone may request a qualified IANA response timezone.",
    "list-drives": LIST_DRIVES_DESCRIPTION,
    "get-drive-root-item": "Read the root item of one OneDrive or SharePoint drive using a driveId returned by list-drives.",
    "list-folder-files": "List the direct children of one OneDrive folder using resolved driveId and driveItemId values. top is the only qualified paging control.",
    "search-onedrive-files": SEARCH_ONEDRIVE_DESCRIPTION,
    "get-drive-item": "Read bounded identity and version metadata for one OneDrive item. Use the exact constant select and includeHeaders=true before a protected mutation.",
    "list-chats": "List recent Microsoft Teams chats. Use a returned chatId to read messages or send a protected reply.",
    "list-chat-messages": "Read recent messages from one Teams chat using a chatId returned by list-chats.",
    "list-joined-teams": LIST_JOINED_TEAMS_DESCRIPTION,
    "list-team-channels": "List channels in one joined Microsoft Team using a teamId returned by list-joined-teams.",
    "list-channel-messages": "Read recent messages from one Teams channel using resolved teamId and channelId values.",
}

MS365_TOOL_DESCRIPTIONS = {
    **MS365_READ_DESCRIPTIONS,
    **CURATED_WRITE_DESCRIPTIONS,
    "upload-file-content": UPLOAD_ONEDRIVE_DESCRIPTION,
    "delete-onedrive-file": DELETE_ONEDRIVE_DESCRIPTION,
}

# The full contract is deliberately enumerable. If the product grants a new
# Softeria tool but this map has not been reviewed, discovery omits it and the
# workspace fails closed instead of inheriting the upstream open schema.
if set(MS365_INPUT_SCHEMAS) != set(MS365_TOOL_DESCRIPTIONS):
    raise RuntimeError("Microsoft 365 contract profiles are incomplete")


def effective_ms365_input_schema(tool_name: str) -> dict:
    input_schema = json.loads(json.dumps(MS365_INPUT_SCHEMAS[tool_name]))
    if tool_name not in WRITE_TOOLS:
        return input_schema
    properties = input_schema.get("properties")
    if isinstance(properties, dict):
        properties.pop("confirm", None)
        properties.pop("excludeResponse", None)
        properties.pop("includeHeaders", None)
        properties["lemmacomputerAudit"] = AUDIT_CONTEXT_SCHEMA
    required = input_schema.get("required")
    if isinstance(required, list):
        required = [item for item in required if item not in {"confirm", "excludeResponse", "includeHeaders"}]
        if tool_name == "delete-onedrive-file":
            required = list(dict.fromkeys(required + ["If-Match"]))
        input_schema["required"] = list(dict.fromkeys(required + ["lemmacomputerAudit"]))
    input_schema["additionalProperties"] = False
    return input_schema


def canonical_agent_instance_id(raw: object) -> str:
    if not isinstance(raw, str):
        raise ValueError("agent process identity must be a UUID string")
    try:
        parsed = uuid.UUID(raw)
    except ValueError as error:
        raise ValueError("agent process identity must be a canonical UUIDv4") from error
    if parsed.version != 4 or str(parsed) != raw:
        raise ValueError("agent process identity must be a canonical UUIDv4")
    return raw


def request_agent_instance_id(params: dict) -> str | None:
    metadata = params.get("_meta")
    if metadata is not None and not isinstance(metadata, dict):
        raise ValueError("MCP request metadata must be an object")
    lemmacomputer = metadata.get("lemmacomputer") if isinstance(metadata, dict) else None
    if lemmacomputer is not None:
        if not isinstance(lemmacomputer, dict) or set(lemmacomputer) != {"agentInstanceId"}:
            raise ValueError("LemmaComputer MCP request metadata is malformed")
        return canonical_agent_instance_id(lemmacomputer.get("agentInstanceId"))
    fallback = os.environ.get("LEMMACOMPUTER_AGENT_INSTANCE_ID", "")
    return canonical_agent_instance_id(fallback) if fallback else None


def request_json(path: str, body: dict | None = None, agent_instance_id: str | None = None) -> dict:
    headers = {} if body is None else {"content-type": "application/json"}
    resolved_agent_instance_id = agent_instance_id
    if resolved_agent_instance_id is None:
        fallback = os.environ.get("LEMMACOMPUTER_AGENT_INSTANCE_ID", "")
        resolved_agent_instance_id = canonical_agent_instance_id(fallback) if fallback else None
    if resolved_agent_instance_id:
        headers["x-lemmacomputer-agent-instance-id"] = resolved_agent_instance_id
    request = urllib.request.Request(
        f"{BROKER}{path}",
        data=None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8"),
        method="GET" if body is None else "POST",
        headers=headers,
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
    if len(decoded) > MAX_INLINE_UPLOAD_BYTES:
        raise ValueError("inline body uploads support at most 4 MB; use localFilePath for resumable uploads")


def prepare_upload_body(arguments: dict) -> bool:
    body = arguments.get("body")
    local_path = arguments.get("localFilePath")
    if body is not None and local_path is not None:
        raise ValueError("supply exactly one of body or localFilePath")
    if local_path is None:
        validate_upload_body(body)
        return False
    if not isinstance(local_path, str) or not os.path.isabs(local_path):
        raise ValueError("localFilePath must be an absolute workspace path")
    resolved = os.path.realpath(local_path)
    try:
        inside_workspace = os.path.commonpath([LOCAL_UPLOAD_ROOT, resolved]) == LOCAL_UPLOAD_ROOT
    except ValueError:
        inside_workspace = False
    if not inside_workspace or not os.path.isfile(resolved):
        raise ValueError("localFilePath must identify a regular file inside this workspace")
    if os.path.getsize(resolved) <= 0:
        raise ValueError("localFilePath must not be empty")
    arguments["localFilePath"] = resolved
    return True


def write_connector_recovery_state(state: str) -> None:
    if not CONNECTOR_RECOVERY_STATE_FILE:
        return
    temporary = f"{CONNECTOR_RECOVERY_STATE_FILE}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        with open(temporary, "w", encoding="utf-8") as output:
            json.dump({
                "state": state,
                "code": "connector_tool_refresh_exhausted" if state == "exhausted" else None,
            }, output, separators=(",", ":"))
            output.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, CONNECTOR_RECOVERY_STATE_FILE)
    except OSError as error:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        print(f"lemmacomputer-connectors-state: {type(error).__name__}", file=sys.stderr, flush=True)


def complete_tool_recovery() -> None:
    global TOOL_LIST_READY, TOOL_REFRESH_NEXT_AT, TOOL_REFRESH_RETRY_SECONDS
    global TOOL_RECOVERY_STARTED_AT, TOOL_RECOVERY_EXHAUSTED
    changed = False
    with TOOL_REFRESH_LOCK:
        if TOOL_RECOVERY_EXHAUSTED:
            return
        changed = not TOOL_LIST_READY or TOOL_RECOVERY_STARTED_AT is not None
        TOOL_LIST_READY = True
        TOOL_REFRESH_NEXT_AT = 0.0
        TOOL_REFRESH_RETRY_SECONDS = 0.0
        TOOL_RECOVERY_STARTED_AT = None
    if changed:
        write_connector_recovery_state("ready")


def begin_tool_recovery(reset: bool = False) -> None:
    global TOOL_RECOVERY_STARTED_AT, TOOL_RECOVERY_EXHAUSTED
    started = False
    with TOOL_REFRESH_LOCK:
        if TOOL_RECOVERY_EXHAUSTED and not reset:
            return
        if reset or TOOL_RECOVERY_STARTED_AT is None:
            TOOL_RECOVERY_STARTED_AT = time.monotonic()
            TOOL_RECOVERY_EXHAUSTED = False
            started = True
    if started:
        write_connector_recovery_state("recovering")


def exhaust_tool_recovery_if_due() -> bool:
    global TOOL_RECOVERY_EXHAUSTED
    exhausted = False
    now = time.monotonic()
    with TOOL_REFRESH_LOCK:
        if (
            not TOOL_RECOVERY_EXHAUSTED
            and TOOL_RECOVERY_STARTED_AT is not None
            and now - TOOL_RECOVERY_STARTED_AT >= CONNECTOR_RECOVERY_DEADLINE_SECONDS
        ):
            TOOL_RECOVERY_EXHAUSTED = True
            exhausted = True
    if exhausted:
        write_connector_recovery_state("exhausted")
    return exhausted


def discover_tools() -> list[dict]:
    response = request_json("/mcp-rest/tools/list")
    tools = response.get("tools", [])
    if not isinstance(tools, list):
        raise RuntimeError("gateway returned an invalid tool list")
    result = []
    TOOLS.clear()
    valid_tools = [
        raw for raw in tools
        if isinstance(raw, dict)
        and isinstance(raw.get("name"), str)
        and raw.get("name") != "create-upload-session"
    ]
    used_names = {WAIT_TOOL_NAME}
    for raw in valid_tools:
        upstream_name = raw["name"]
        mcp_info = raw.get("mcp_info") if isinstance(raw.get("mcp_info"), dict) else {}
        server_name = str(mcp_info.get("server_name") or "")
        is_microsoft365 = server_name == "lemmacomputer_ms365"
        if is_microsoft365 and upstream_name not in MS365_INPUT_SCHEMAS:
            print(
                f"lemmacomputer-connectors-contract: omitted unqualified Microsoft 365 tool {upstream_name}",
                file=sys.stderr,
                flush=True,
            )
            continue
        server_label = str(server_name or mcp_info.get("server_id") or "connector")
        server_label = re.sub(r"[^A-Za-z0-9_-]+", "_", server_label).strip("_").lower()
        if server_label.startswith("lemmacomputer_"):
            server_label = server_label.removeprefix("lemmacomputer_")
        if server_label == "ms365":
            server_label = "microsoft365"
        server_label = server_label[:32] or "connector"
        visible_name = f"{server_label}__{upstream_name}"
        unique_name = visible_name
        suffix = 2
        while unique_name in used_names:
            unique_name = f"{visible_name}_{suffix}"
            suffix += 1
        visible_name = unique_name
        used_names.add(visible_name)
        selected = dict(raw)
        selected["_lemmacomputer_upstream_name"] = upstream_name
        input_schema = raw.get("inputSchema", raw.get("input_schema", {"type": "object"}))
        if is_microsoft365:
            input_schema = effective_ms365_input_schema(upstream_name)
        selected["_lemmacomputer_input_schema"] = input_schema
        selected["_lemmacomputer_contract_version"] = MS365_CONTRACT_VERSION if is_microsoft365 else None
        TOOLS[visible_name] = selected
        result.append({
            "name": visible_name,
            "description": MS365_TOOL_DESCRIPTIONS[upstream_name] if is_microsoft365
                else raw.get("description", f"{server_label} tool governed by LemmaComputer policy."),
            "inputSchema": input_schema,
            **({"_meta": {"lemmacomputer": {"contractVersion": MS365_CONTRACT_VERSION}}} if is_microsoft365 else {}),
        })
    TOOLS[WAIT_TOOL_NAME] = {"name": WAIT_TOOL_NAME, "lemmacomputer_local": True}
    result.append({
        "name": WAIT_TOOL_NAME,
        "description": "Wait for a protected LemmaComputer operation after another Microsoft 365 tool reports that signed approval is pending. Waits for up to 75 seconds. If the operation is still pending, call this tool again with the same operationId. Do not retry the original destructive tool.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "operationId": {
                    "type": "string",
                    "description": "The LemmaComputer governed operation ID returned by the protected tool.",
                },
            },
            "required": ["operationId"],
            "additionalProperties": False,
        },
    })
    complete_tool_recovery()
    return result


def connector_tool_signature() -> str:
    """Read Control's durable projection fingerprint without probing providers."""
    response = request_json("/mcp-rest/tools/signature")
    signature = response.get("signature")
    if not isinstance(signature, str) or not re.fullmatch(r"[a-f0-9]{64}", signature):
        raise RuntimeError("gateway returned an invalid connector projection signature")
    return signature


def notify_tools_changed() -> None:
    document = {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
    with RESPONSE_LOCK:
        print(json.dumps(document, separators=(",", ":")), flush=True)


def tool_refresh_notification_due(interval: float, projection_changed: bool) -> bool:
    """Schedule bounded refresh notifications until Hermes lists tools successfully."""
    global TOOL_LIST_READY, TOOL_REFRESH_NEXT_AT, TOOL_REFRESH_RETRY_SECONDS
    now = time.monotonic()
    with TOOL_REFRESH_LOCK:
        if projection_changed:
            TOOL_LIST_READY = False
            TOOL_REFRESH_NEXT_AT = 0.0
            TOOL_REFRESH_RETRY_SECONDS = interval
        if TOOL_RECOVERY_EXHAUSTED or TOOL_LIST_READY or now < TOOL_REFRESH_NEXT_AT:
            return False
        delay = TOOL_REFRESH_RETRY_SECONDS or interval
        TOOL_REFRESH_NEXT_AT = now + delay
        TOOL_REFRESH_RETRY_SECONDS = min(60.0, delay * 2)
        return True


def monitor_tool_changes() -> None:
    try:
        interval = float(os.environ.get("LEMMACOMPUTER_CONNECTOR_REFRESH_SECONDS", "5"))
    except ValueError:
        interval = 5.0
    interval = min(60.0, max(0.1, interval))
    last_signature: str | None = None
    begin_tool_recovery(reset=True)
    while True:
        try:
            signature = connector_tool_signature()
            projection_changed = last_signature is not None and signature != last_signature
            if projection_changed:
                begin_tool_recovery(reset=True)
            elif TOOL_LIST_READY:
                complete_tool_recovery()
            if tool_refresh_notification_due(interval, projection_changed):
                notify_tools_changed()
            last_signature = signature
        except Exception as error:
            # Transient discovery failures must neither terminate the MCP
            # transport nor make the previous tool snapshot disappear.
            begin_tool_recovery()
            print(f"lemmacomputer-connectors-monitor: {type(error).__name__}", file=sys.stderr, flush=True)
        if exhaust_tool_recovery_if_due():
            print("lemmacomputer-connectors-monitor: recovery deadline exhausted", file=sys.stderr, flush=True)
            return
        time.sleep(interval)


def start_tool_change_monitor() -> None:
    global TOOL_MONITOR_STARTED
    with TOOL_MONITOR_LOCK:
        if TOOL_MONITOR_STARTED:
            return
        TOOL_MONITOR_STARTED = True
    threading.Thread(
        target=monitor_tool_changes,
        daemon=True,
        name="lemmacomputer-connectors-tool-monitor",
    ).start()


def wait_for_operation(identifier: str, agent_instance_id: str | None, timeout_seconds: int = 75) -> dict:
    deadline = time.monotonic() + timeout_seconds
    operation: dict = {"id": identifier, "state": "approval_required"}
    while time.monotonic() < deadline:
        operation = request_json(f"/lemmacomputer/operations/{identifier}", agent_instance_id=agent_instance_id)
        state = operation.get("state")
        if state in {"succeeded", "denied", "failed", "expired"}:
            return operation
        if state == "approved" and identifier in LOCAL_UPLOADS:
            request_json("/lemmacomputer/uploads/start", {"operationId": identifier}, agent_instance_id)
        time.sleep(1)
    return operation


def operation_result(operation: dict, identifier: str) -> dict:
    if operation.get("state") == "succeeded":
        receipt = operation.get("receipt") if isinstance(operation.get("receipt"), dict) else {}
        summary = receipt.get("resultSummary") or f"{operation.get('safeSummary', 'The governed action')} completed after approval."
        return {
            "content": [{"type": "text", "text": str(summary)}],
            "isError": False,
            "_meta": {"lemmacomputer": {"operationId": identifier, "state": "succeeded", "approval": "openvtc-task-consent"}},
        }
    state = operation.get("state", "failed")
    if state in {"approval_required", "approved", "executing"}:
        return {
            "content": [{"type": "text", "text": f"The signed approval for operation {identifier} is still pending or being executed. The protected action has not returned a final result. Call {WAIT_TOOL_NAME} again with this same operationId; do not retry the original destructive tool."}],
            "isError": False,
            "_meta": {"lemmacomputer": {"operationId": identifier, "state": state, "approval": "openvtc-task-consent"}},
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
            category="provider_rejection",
            retryable=False,
        )
    return error_result(
        f"The governed action was {state}. No further tool execution occurred.",
        identifier,
        state,
        category="policy_denial" if state in {"denied", "expired"} else "unknown_failure",
        retryable=state not in {"denied", "expired"},
    )


def validate_contract_arguments(selected: dict, arguments: dict) -> dict | None:
    schema = selected.get("_lemmacomputer_input_schema")
    if not isinstance(schema, dict) or schema.get("additionalProperties") is not False:
        return None
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    unsupported = sorted(key for key in arguments if key not in properties)
    if unsupported:
        field = unsupported[0]
        safe_field = bounded_failure_field(field)
        return error_result(
            (
                f"Unsupported field '{safe_field}'. Use only the fields in the published Microsoft 365 tool contract; raw Graph filter, search, order, path, and header syntax is not accepted."
                if safe_field
                else "An unsupported field was omitted. Use only the fields in the published Microsoft 365 tool contract; raw Graph filter, search, order, path, and header syntax is not accepted."
            ),
            category="unsupported_option",
            field=safe_field,
            retryable=False,
        )
    return None


def call_tool(name: str, arguments: dict, agent_instance_id: str | None = None) -> dict:
    selected = TOOLS.get(name)
    if selected is None:
        discover_tools()
        selected = TOOLS.get(name)
    if name == WAIT_TOOL_NAME:
        identifier = arguments.get("operationId")
        if not isinstance(identifier, str) or not identifier:
            return error_result(
                "A governed operationId is required.",
                category="invalid_argument",
                field="operationId",
                retryable=False,
            )
        return operation_result(wait_for_operation(identifier, agent_instance_id), identifier)
    server_id = (selected or {}).get("mcp_info", {}).get("server_id")
    if not isinstance(server_id, str):
        return error_result(
            "That tool is not assigned to this workspace.",
            category="policy_denial",
            retryable=False,
        )
    upstream_name = (selected or {}).get("_lemmacomputer_upstream_name", name)
    if upstream_name in WRITE_TOOLS:
        # Connector execution flags are never accepted from the model. The
        # managed bridge supplies Softeria's confirmation flag, while Control
        # independently decides whether the action is allowed, held for signed
        # approval, or denied before the connector can execute it.
        arguments = {key: value for key, value in arguments.items() if key not in {"confirm", "excludeResponse", "includeHeaders"}}
        arguments["confirm"] = True
    contract_arguments = {key: value for key, value in arguments.items() if key != "confirm"}
    contract_error = validate_contract_arguments(selected or {}, contract_arguments)
    if contract_error:
        return contract_error
    if upstream_name == "upload-file-content":
        try:
            arguments["driveItemId"] = normalize_upload_drive_item_id(arguments.get("driveItemId"))
        except ValueError as error:
            return error_result(
                f"The OneDrive upload was not submitted: {error}. "
                "Use an opaque item ID, root:/file.txt:, or root:/folder/file.txt: as driveItemId.",
                category="invalid_argument",
                field="driveItemId",
                retryable=False,
            )
        try:
            local_upload = prepare_upload_body(arguments)
        except ValueError as error:
            detail = str(error)
            field = "localFilePath" if "localFilePath" in detail else "body" if "body" in detail else None
            return error_result(
                f"The OneDrive upload was not submitted: {detail}.",
                category="invalid_argument",
                field=field,
                retryable=False,
            )
        if local_upload:
            try:
                response = request_json("/lemmacomputer/uploads", {
                    "driveId": arguments["driveId"],
                    "driveItemId": arguments["driveItemId"],
                    "localFilePath": arguments["localFilePath"],
                }, agent_instance_id)
                operation = response.get("operation") if isinstance(response.get("operation"), dict) else {}
                identifier = operation.get("id")
                if not isinstance(identifier, str):
                    return error_result(
                        "LemmaComputer did not create a governed resumable upload.",
                        category="unknown_failure",
                        retryable=True,
                    )
                LOCAL_UPLOADS[identifier] = {
                    "driveId": arguments["driveId"],
                    "driveItemId": arguments["driveItemId"],
                    "localFilePath": arguments["localFilePath"],
                }
                if operation.get("state") == "succeeded":
                    return operation_result(operation, identifier)
                return {
                    "content": [{"type": "text", "text": f"Signed approval is required for resumable upload operation {identifier}. The file has not been uploaded. Call {WAIT_TOOL_NAME} now with this operationId."}],
                    "isError": False,
                    "_meta": {"lemmacomputer": {"operationId": identifier, "state": operation.get("state", "approval_required"), "approval": "openvtc-task-consent"}},
                }
            except (OSError, ValueError, urllib.error.URLError):
                return error_result(
                    "The governed resumable upload service is unavailable.",
                    category="unknown_failure",
                    retryable=True,
                )
    if upstream_name == "delete-onedrive-file":
        if (not isinstance(arguments.get("resourceName"), str)
                or not arguments["resourceName"].strip()
                or not isinstance(arguments.get("If-Match"), str)
                or not arguments["If-Match"].strip()):
            return error_result(
                DELETE_ONEDRIVE_MISSING_METADATA,
                category="invalid_argument",
                retryable=False,
            )
        arguments["If-Match"] = normalize_graph_etag(arguments["If-Match"])
        try:
            response = request_json("/lemmacomputer/deletions", {
                "driveId": arguments["driveId"],
                "driveItemId": arguments["driveItemId"],
                "resourceName": arguments["resourceName"].strip(),
                "If-Match": arguments["If-Match"],
            }, agent_instance_id)
            operation = response.get("operation") if isinstance(response.get("operation"), dict) else {}
            identifier = operation.get("id")
            if not isinstance(identifier, str):
                return error_result(
                    "LemmaComputer did not create a governed OneDrive deletion.",
                    category="unknown_failure",
                    retryable=True,
                )
            if operation.get("state") == "succeeded":
                return operation_result(operation, identifier)
            return {
                "content": [{"type": "text", "text": f"Signed approval is required to delete {arguments['resourceName']} from OneDrive. The file has not been deleted. Call {WAIT_TOOL_NAME} now with operationId {identifier}."}],
                "isError": False,
                "_meta": {"lemmacomputer": {"operationId": identifier, "state": operation.get("state", "approval_required"), "approval": "openvtc-task-consent"}},
            }
        except (OSError, ValueError, KeyError, urllib.error.URLError):
            return error_result(
                "The governed OneDrive deletion service is unavailable.",
                category="unknown_failure",
                retryable=True,
            )
    try:
        response = request_json("/mcp-rest/tools/call", {
            "server_id": server_id,
            "name": upstream_name,
            "arguments": arguments,
        }, agent_instance_id)
        if not isinstance(response.get("content"), list):
            return error_result(
                "The connected service returned an invalid tool result.",
                category="unknown_failure",
                retryable=True,
            )
        if response.get("isError") is True:
            failure = upstream_m365_failure(response)
            return error_result(
                failure["message"],
                category=failure["category"],
                retryable=failure["retryable"],
            )
        return omit_nulls(response)
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {}
        identifier = operation_id(payload)
        if error.code != 409 or not identifier:
            problem = nested_problem(payload)
            if problem:
                return error_result(
                    problem["message"],
                    category=problem["category"],
                    field=problem.get("field"),
                    retryable=problem["retryable"],
                )
            code = nested_error(payload)
            message = (
                f"LemmaComputer rejected the tool call with safe code {code}."
                if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Z0-9_]{2,127}", code)
                else f"LemmaComputer rejected the tool call (HTTP {error.code})."
            )
            if error.code == 401:
                category, retryable = "authentication_failure", False
            elif error.code == 403:
                category, retryable = "policy_denial", False
            elif error.code in {408, 425, 429}:
                category, retryable = "provider_rejection", True
            elif error.code >= 500:
                category, retryable = "unknown_failure", True
            else:
                category, retryable = "provider_rejection", False
            return error_result(message, category=category, retryable=retryable)
    except TimeoutError:
        return error_result(
            "Microsoft 365 did not respond before the bounded connector timeout.",
            category="timeout",
            retryable=True,
        )
    except urllib.error.URLError:
        return error_result(
            "The Microsoft 365 connector is temporarily unavailable.",
            category="unknown_failure",
            retryable=True,
        )

    return {
        "content": [{"type": "text", "text": f"Signed approval is required for operation {identifier}. The action has not run. Call {WAIT_TOOL_NAME} now with this operationId and keep calling it while approval remains pending. Do not retry the original destructive tool."}],
        "isError": False,
        "_meta": {"lemmacomputer": {"operationId": identifier, "state": "approval_required", "approval": "openvtc-task-consent"}},
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


def nested_problem(value: object) -> dict | None:
    if isinstance(value, dict):
        category = value.get("category")
        message = value.get("message")
        field = value.get("field")
        retryable = value.get("retryable")
        if (
            category in {
                "invalid_argument", "unsupported_option", "authentication_failure", "policy_denial",
                "provider_rejection", "timeout", "unknown_failure",
            }
            and isinstance(message, str) and 1 <= len(message) <= 320
            and (field is None or isinstance(field, str) and 1 <= len(field) <= 128)
            and isinstance(retryable, bool)
        ):
            return {"category": category, "message": message, "field": field, "retryable": retryable}
        for child in value.values():
            found = nested_problem(child)
            if found:
                return found
    if isinstance(value, list):
        for child in value:
            found = nested_problem(child)
            if found:
                return found
    return None


def upstream_m365_failure(response: dict) -> dict:
    """Classify only pinned Softeria error wrappers without exposing Graph text."""

    error_message = None
    for item in response.get("content", []):
        if not isinstance(item, dict) or item.get("type") != "text" or not isinstance(item.get("text"), str):
            continue
        try:
            payload = json.loads(item["text"])
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict) and isinstance(payload.get("error"), str):
            error_message = payload["error"]
            break
    if error_message is None:
        return {
            "category": "unknown_failure",
            "message": "Microsoft 365 could not complete the request. Retry once; if it fails again, reconnect the Microsoft 365 account or verify the resolved resource IDs.",
            "retryable": True,
        }
    wrapped = re.match(r"^Error in tool [A-Za-z0-9_-]+: (.+)$", error_message, re.DOTALL)
    if wrapped:
        error_message = wrapped.group(1)
    if error_message == "No access token available" or error_message.startswith("Failed to acquire token for account "):
        return {
            "category": "authentication_failure",
            "message": "The Microsoft 365 sign-in is no longer usable. Reconnect the Microsoft 365 account, then retry the request.",
            "retryable": False,
        }
    matched = re.match(r"^Microsoft Graph API (?:scope )?error: ([1-5][0-9]{2})(?:\s|$)", error_message)
    if matched:
        status = int(matched.group(1))
        if status in {401, 403}:
            return {
                "category": "authentication_failure",
                "message": "Microsoft 365 authentication or consent is no longer sufficient. Reconnect the account and review its granted permissions.",
                "retryable": False,
            }
        if status == 408:
            return {
                "category": "timeout",
                "message": "Microsoft 365 did not respond before the bounded request timeout. Retry once.",
                "retryable": True,
            }
        if status in {425, 429} or status >= 500:
            return {
                "category": "provider_rejection",
                "message": "Microsoft 365 is temporarily unable to complete the request. Retry once after a short delay.",
                "retryable": True,
            }
        return {
            "category": "provider_rejection",
            "message": "Microsoft 365 rejected the request. Check the published tool fields and resolved resource IDs before retrying.",
            "retryable": False,
        }
    return {
        "category": "unknown_failure",
        "message": "Microsoft 365 could not complete the request. Retry once; if it fails again, reconnect the Microsoft 365 account or verify the resolved resource IDs.",
        "retryable": True,
    }


def bounded_failure_field(value: object) -> str | None:
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value):
        return value
    return None


def bounded_failure_message(message: str) -> str:
    if 1 <= len(message) <= 320:
        return message
    return "The connector request failed. Review the published tool contract and retry only when the error is marked retryable."


def error_result(
    message: str,
    identifier: str | None = None,
    state: str | None = None,
    category: str = "unknown_failure",
    field: str | None = None,
    retryable: bool | None = None,
) -> dict:
    if retryable is None:
        retryable = category in {"timeout", "unknown_failure"}
    result = {"content": [{"type": "text", "text": message}], "isError": True}
    metadata = {"failure": {
        "category": category,
        "field": bounded_failure_field(field),
        "message": bounded_failure_message(message),
        "retryable": retryable,
    }}
    if identifier:
        metadata.update({"operationId": identifier, "state": state})
    result["_meta"] = {"lemmacomputer": metadata}
    return result


def respond(identifier: object, result: dict | None = None, error: dict | None = None) -> None:
    document = {"jsonrpc": "2.0", "id": identifier}
    document["result" if error is None else "error"] = result if error is None else error
    with RESPONSE_LOCK:
        print(json.dumps(document, separators=(",", ":")), flush=True)


def execute_tool_call(identifier: object, name: str, arguments: dict, agent_instance_id: str | None) -> None:
    try:
        respond(identifier, call_tool(name, arguments, agent_instance_id))
    except Exception as error:  # Tool failures must not terminate the managed connector.
        print(f"lemmacomputer-connectors: {type(error).__name__}", file=sys.stderr, flush=True)
        respond(identifier, error={
            "code": -32603,
            "message": "The governed connector bridge is unavailable.",
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
                "capabilities": {"tools": {"listChanged": True}},
                "serverInfo": {"name": "lemmacomputer-connectors", "version": "0.1.0"},
                "instructions": "Tools are prefixed with their connected service name and operate on remote service resources. Use the corresponding MCP tool directly. Read calls normally run immediately. Writes may return a governed operation; call wait-for-governed-operation with that operationId until signed approval or denial is final. Never substitute Cowork or local-filesystem permission tools for remote-service actions. LemmaComputer Control enforces policy and obtains signed approval inside protected tool calls.",
            })
            start_tool_change_monitor()
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
            try:
                agent_instance_id = request_agent_instance_id(params)
            except ValueError as error:
                respond(identifier, error_result(
                    f"The connector call was rejected: {error}.",
                    category="authentication_failure",
                    field="_meta.lemmacomputer.agentInstanceId",
                ))
                return
            # A governed operation may wait for a human decision. Keep the
            # JSON-RPC input loop available for MCP pings while that call is
            # pending; otherwise Hermes declares the healthy stdio bridge dead
            # and orphans the operation before its approved result can return.
            threading.Thread(
                target=execute_tool_call,
                args=(identifier, name, arguments, agent_instance_id),
                daemon=True,
                name=f"lemmacomputer-connectors-call-{identifier}",
            ).start()
        else:
            respond(identifier, error={"code": -32601, "message": "Method not found"})
    except Exception as error:  # MCP must report failures without terminating the managed connector.
        print(f"lemmacomputer-connectors: {type(error).__name__}", file=sys.stderr, flush=True)
        respond(identifier, error={"code": -32603, "message": "The governed connector bridge is unavailable."})


if os.environ.get("LEMMACOMPUTER_PRINT_MS365_CONTRACTS") == "1":
    print(json.dumps({
        "version": MS365_CONTRACT_VERSION,
        "tools": {
            name: {
                "description": MS365_TOOL_DESCRIPTIONS[name],
                "inputSchema": effective_ms365_input_schema(name),
            }
            for name in sorted(MS365_INPUT_SCHEMAS)
        },
    }, sort_keys=True, separators=(",", ":")))
    raise SystemExit(0)


for line in sys.stdin:
    try:
        message = json.loads(line)
        if isinstance(message, dict):
            handle(message)
    except json.JSONDecodeError:
        print("lemmacomputer-connectors: ignored malformed input", file=sys.stderr, flush=True)
