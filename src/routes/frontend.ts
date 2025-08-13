import { Router, Request, Response } from "express";
import moment from "moment-timezone";
import { marked } from "marked";
import { markdownToSanitizedHTML, renderPlain } from "../util/markdown.js";
import {
    frontendConfig,
    instanceDescription,
    instanceRules,
} from "../lib/config.js";
import { addToLog, exportIcal } from "../helpers.js";
import Event from "../models/Event.js";
import EventGroup, { IEventGroup } from "../models/EventGroup.js";
import {
    acceptsActivityPub,
    activityPubContentType,
} from "../lib/activitypub.js";
import MagicLink from "../models/MagicLink.js";
import { getConfigMiddleware } from "../lib/middleware.js";
import { getMessage } from "../util/messages.js";
import { EventListEvent, bucketEventsByMonth } from "../lib/event.js";
import i18next from "i18next";

const router = Router();

// Add config middleware to all routes
router.use(getConfigMiddleware);

router.get("/", (_, res) => {
    if (res.locals.config?.general.show_public_event_list) {
        return res.redirect("/events");
    }
    return res.render("home", {
        ...frontendConfig(res),
        instanceRules: instanceRules(),
        instanceDescription: instanceDescription(),
    });
});

router.get("/about", (_: Request, res: Response) => {
    return res.render("home", {
        ...frontendConfig(res),
        instanceRules: instanceRules(),
        instanceDescription: instanceDescription(),
    });
});

router.get("/new", (_: Request, res: Response) => {
    if (res.locals.config?.general.creator_email_addresses?.length) {
        return res.render("createEventMagicLink", frontendConfig(res));
    }
    return res.render("newevent", {
        title: i18next.t("frontend.newevent"),
        ...frontendConfig(res),
    });
});

router.get("/new/:magicLinkToken", async (req: Request, res: Response) => {
    // If we don't have any creator email addresses, we don't need to check the magic link
    // so we can just redirect to the new event page
    if (!res.locals.config?.general.creator_email_addresses?.length) {
        return res.redirect("/new");
    }
    const magicLink = await MagicLink.findOne({
        token: req.params.magicLinkToken,
        expiryTime: { $gt: new Date() },
        permittedActions: "createEvent",
    });
    if (!magicLink) {
        return res.render("createEventMagicLink", {
            ...frontendConfig(res),
            message: {
                type: "danger",
                text: i18next.t("routes.magiclink-invalid"),
            },
        });
    }
    res.render("newevent", {
        title: i18next.t("frontend.newevent"),
        ...frontendConfig(res),
        magicLinkToken: req.params.magicLinkToken,
        creatorEmail: magicLink.email,
    });
});

router.get("/events", async (_: Request, res: Response) => {
    if (!res.locals.config?.general.show_public_event_list) {
        return res.status(404).render("404", frontendConfig(res));
    }
    const events = await Event.find({ showOnPublicList: true })
        .populate("eventGroup")
        .lean()
        .sort("start");
    const updatedEvents: EventListEvent[] = events.map((event) => {
        const startMoment = moment.tz(event.start, event.timezone);
        const endMoment = moment.tz(event.end, event.timezone);
        const isSameDay = startMoment.isSame(endMoment, "day");

        return {
            id: event.id,
            name: event.name,
            location: event.location,
            displayDate: isSameDay
                ? startMoment.format("LL")
                : `${startMoment.format("LL")} - ${endMoment.format(
                      "LL",
                  )}`,
            eventHasConcluded: endMoment.isBefore(moment.tz(event.timezone)),
            eventGroup: event.eventGroup as unknown as IEventGroup,
            startMoment,
            endMoment,
        };
    });
    const upcomingEventsInMonthBuckets = updatedEvents
        .filter((event) => event.eventHasConcluded === false)
        .reduce(bucketEventsByMonth, []);
    const pastEventsInMonthBuckets = updatedEvents
        .filter((event) => event.eventHasConcluded === true)
        .reduce(bucketEventsByMonth, []);
    const eventGroups = await EventGroup.find({
        showOnPublicList: true,
    }).lean();
    const updatedEventGroups = eventGroups.map((eventGroup) => {
        return {
            id: eventGroup.id,
            name: eventGroup.name,
            numberOfEvents: updatedEvents.filter(
                (event) =>
                    event.eventGroup?._id.toString() ===
                    eventGroup._id.toString(),
            ).length,
        };
    });

    res.render("publicEventList", {
        title: i18next.t("frontend.publicevents"),
        upcomingEvents: upcomingEventsInMonthBuckets,
        pastEvents: pastEventsInMonthBuckets,
        eventGroups: updatedEventGroups,
        instanceDescription: instanceDescription(),
        instanceRules: instanceRules(),
        ...frontendConfig(res),
    });
});

router.get("/:eventID", async (req: Request, res: Response) => {
    try {
        const event = await Event.findOne({
            id: req.params.eventID,
        })
            .lean() // Required, see: https://stackoverflow.com/questions/59690923/handlebars-access-has-been-denied-to-resolve-the-property-from-because-it-is
            .populate("eventGroup");
        if (!event) {
            return res.status(404).render("404", frontendConfig(res));
        }
        const parsedLocation = event.location.replace(/\s+/g, "+");
        let displayDate;
        const dateformat = i18next.t("frontend.dateformat");
        const timeformat = i18next.t('frontend.timeformat');
        if (moment.tz(event.end, event.timezone).isSame(event.start, "day")) {
            // Happening during one day
            displayDate = i18next.t("frontend.displaydate-sameday",
                { 
                    startdate: 
                        moment
                            .tz(event.start, event.timezone)
                            .format(dateformat),
                    starttime:
                        moment
                            .tz(event.start, event.timezone)
                            .format(timeformat),
                    endtime:
                        moment
                            .tz(event.end, event.timezone)
                            .format(timeformat),
                    timezone:
                        moment
                            .tz(event.end, event.timezone)
                            .format('(z)',)
                });
        } else {
            displayDate = i18next.t("frontend.displaydate-days",
                {
                    startdate:
                        moment
                            .tz(event.start, event.timezone)
                            .format(dateformat),
                    starttime:
                        moment
                            .tz(event.start, event.timezone)
                            .format(timeformat),
                    enddate:
                        moment
                            .tz(event.end, event.timezone)
                            .format(dateformat),
                    endtime:
                        moment
                            .tz(event.end, event.timezone)
                            .format(timeformat),
                    timezone:
                        moment
                            .tz(event.end, event.timezone)
                            .format('(z)',)
                });
        }
        const eventStartISO = moment.tz(event.start, "Etc/UTC").toISOString();
        const eventEndISO = moment.tz(event.end, "Etc/UTC").toISOString();
        const parsedStart = moment
            .tz(event.start, event.timezone)
            .format("YYYYMMDD[T]HHmmss");
        const parsedEnd = moment
            .tz(event.end, event.timezone)
            .format("YYYYMMDD[T]HHmmss");
        // See: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/input/datetime-local
        const parsedStartForDateInput = moment
            .tz(event.start, event.timezone)
            .format("YYYY-MM-DDTHH:mm");
        const parsedEndForDateInput = moment
            .tz(event.end, event.timezone)
            .format("YYYY-MM-DDTHH:mm");
        let eventHasConcluded = false;
        if (
            moment
                .tz(event.end, event.timezone)
                .isBefore(moment.tz(event.timezone))
        ) {
            eventHasConcluded = true;
        }
        let eventHasBegun = false;
        if (
            moment
                .tz(event.start, event.timezone)
                .isBefore(moment.tz(event.timezone))
        ) {
            eventHasBegun = true;
        }
        const fromNow = moment.tz(event.start, event.timezone).fromNow();
        const parsedDescription = markdownToSanitizedHTML(event.description);
        const eventEditToken = event.editToken;

        const escapedName = encodeURIComponent(event.name);

        let eventHasCoverImage = false;
        if (event.image) {
            eventHasCoverImage = true;
        } else {
            eventHasCoverImage = false;
        }
        let eventHasHost = false;
        if (event.hostName) {
            eventHasHost = true;
        } else {
            eventHasHost = false;
        }
        let firstLoad = false;
        if (event.firstLoad === true) {
            firstLoad = true;
            await Event.findOneAndUpdate(
                { id: req.params.eventID },
                { firstLoad: false },
            );
        }
        let editingEnabled = false;
        if (Object.keys(req.query).length !== 0) {
            if (!req.query.e) {
                editingEnabled = false;
                console.log("No edit token set");
            } else {
                if (req.query.e === eventEditToken) {
                    editingEnabled = true;
                } else {
                    editingEnabled = false;
                }
            }
        }
        const eventAttendees = event.attendees
            ?.sort((a, b) => (a.name > b.name ? 1 : b.name > a.name ? -1 : 0))
            .map((el) => {
                if (!el.id) {
                    el.id = el._id;
                }
                if (el.number && el.number > 1) {
                    el.name = `${el.name} ${i18next.t("frontend.elnumber", { count: el.number })}`;
                }
                return {
                    ...el,
                    // Backwards compatibility - if visibility is not set, default to public
                    visibility: el.visibility || "public",
                };
            })
            .filter((obj, pos, arr) => {
                return (
                    obj.status === "attending" &&
                    arr.map((mapObj) => mapObj.id).indexOf(obj.id) === pos
                );
            });

        let spotsRemaining, noMoreSpots;
        const numberOfAttendees =
            eventAttendees?.reduce((acc, attendee) => {
                if (attendee.status === "attending") {
                    return acc + (attendee.number || 1);
                }
                return acc;
            }, 0) || 0;
        const visibleAttendees = eventAttendees?.filter(
            (attendee) => attendee.visibility === "public",
        );
        const hiddenAttendees = eventAttendees?.filter(
            (attendee) => attendee.visibility === "private",
        );
        const numberOfHiddenAttendees = eventAttendees?.reduce(
            (acc, attendee) => {
                if (
                    attendee.status === "attending" &&
                    attendee.visibility === "private"
                ) {
                    return acc + (attendee.number || 1);
                }
                return acc;
            },
            0,
        );
        if (event.maxAttendees) {
            spotsRemaining = event.maxAttendees - numberOfAttendees;
            if (spotsRemaining <= 0) {
                noMoreSpots = true;
            }
        }
        const metadata = {
            title: event.name,
            description: (
                marked.parse(event.description, {
                    renderer: renderPlain(),
                }) as string
            )
                .split(" ")
                .splice(0, 40)
                .join(" ")
                .trim(),
            image: eventHasCoverImage
                ? `https://${res.locals.config?.general.domain}/events/` +
                  event.image
                : null,
            url:
                `https://${res.locals.config?.general.domain}/` +
                req.params.eventID,
        };
        if (acceptsActivityPub(req)) {
            res.header("Content-Type", activityPubContentType).send(
                JSON.parse(event.activityPubActor || "{}"),
            );
        } else {
            res.set("X-Robots-Tag", "noindex");
            res.render("event", {
                ...frontendConfig(res),
                title: event.name,
                escapedName: escapedName,
                eventData: event,
                visibleAttendees,
                hiddenAttendees,
                numberOfAttendees,
                numberOfHiddenAttendees,
                spotsRemaining: spotsRemaining,
                noMoreSpots: noMoreSpots,
                eventStartISO: eventStartISO,
                eventEndISO: eventEndISO,
                parsedLocation: parsedLocation,
                parsedStart: parsedStart,
                parsedEnd: parsedEnd,
                parsedStartForDateInput,
                parsedEndForDateInput,
                displayDate: displayDate,
                fromNow: fromNow,
                timezone: event.timezone,
                parsedDescription: parsedDescription,
                editingEnabled: editingEnabled,
                eventHasCoverImage: eventHasCoverImage,
                eventHasHost: eventHasHost,
                firstLoad: firstLoad,
                eventHasConcluded: eventHasConcluded,
                eventHasBegun: eventHasBegun,
                eventWillBeDeleted:
                    (res.locals.config?.general.delete_after_days || 0) > 0,
                daysUntilDeletion: moment
                    .tz(event.end, event.timezone)
                    .add(res.locals.config?.general.delete_after_days, "days")
                    .fromNow(),
                metadata: metadata,
                jsonData: {
                    name: event.name,
                    id: event.id,
                    description: event.description,
                    location: event.location,
                    timezone: event.timezone,
                    url: event.url,
                    hostName: event.hostName,
                    creatorEmail: event.creatorEmail,
                    showOnPublicList: event.showOnPublicList,
                    eventGroupID: event.eventGroup
                        ? (event.eventGroup as unknown as IEventGroup).id
                        : null,
                    eventGroupEditToken: event.eventGroup
                        ? (event.eventGroup as unknown as IEventGroup).editToken
                        : null,
                    usersCanAttend: event.usersCanAttend,
                    usersCanComment: event.usersCanComment,
                    maxAttendees: event.maxAttendees,
                    startISO: eventStartISO,
                    endISO: eventEndISO,
                    startForDateInput: parsedStartForDateInput,
                    endForDateInput: parsedEndForDateInput,
                    image: event.image,
                    editToken: editingEnabled ? eventEditToken : null,
                },
                message: getMessage(req.query.m as string),
            });
        }
    } catch (err) {
        addToLog(
            "displayEvent",
            "error",
            "Attempt to display event " +
                req.params.eventID +
                " failed with error: " +
                err,
        );
        console.log(err);
        return res.status(404).render("404", frontendConfig(res));
    }
});

router.get("/group/:eventGroupID", async (req: Request, res: Response) => {
    try {
        const eventGroup = await EventGroup.findOne({
            id: req.params.eventGroupID,
        }).lean();

        if (!eventGroup) {
            return res.status(404).render("404", frontendConfig(res));
        }
        const parsedDescription = markdownToSanitizedHTML(
            eventGroup.description,
        );
        const eventGroupEditToken = eventGroup.editToken;
        const escapedName = eventGroup.name.replace(/\s+/g, "+");
        const eventGroupHasCoverImage = !!eventGroup.image;
        const eventGroupHasHost = !!eventGroup.hostName;

        const events = await Event.find({ eventGroup: eventGroup._id })
            .lean()
            .sort("start");

        const updatedEvents: EventListEvent[] = events.map((event) => {
            const startMoment = moment.tz(event.start, event.timezone).locale(i18next.language);
            const endMoment = moment.tz(event.end, event.timezone).locale(i18next.language);
            const isSameDay = startMoment.isSame(endMoment, "day");

            return {
                id: event.id,
                name: event.name,
                location: event.location,
                displayDate: isSameDay
                    ? startMoment.format("LL")
                    : `${startMoment.format("LL")} - ${endMoment.format("LL")}`,
                eventHasConcluded: endMoment.isBefore(
                    moment.tz(event.timezone),
                ),
                startMoment,
                endMoment,
            };
        });

        const upcomingEventsInMonthBuckets = updatedEvents
            .filter((event) => !event.eventHasConcluded)
            .reduce(bucketEventsByMonth, []);

        const pastEventsInMonthBuckets = updatedEvents
            .filter((event) => event.eventHasConcluded)
            .reduce(bucketEventsByMonth, []);

        let firstLoad = false;
        if (eventGroup.firstLoad === true) {
            firstLoad = true;
            await EventGroup.findOneAndUpdate(
                { id: req.params.eventGroupID },
                { firstLoad: false },
            );
        }

        let editingEnabled = false;
        if (Object.keys(req.query).length !== 0) {
            if (!req.query.e) {
                editingEnabled = false;
            } else {
                editingEnabled = req.query.e === eventGroupEditToken;
            }
        }

        const metadata = {
            title: eventGroup.name,
            description: (
                marked.parse(eventGroup.description, {
                    renderer: renderPlain(),
                }) as string
            )
                .split(" ")
                .splice(0, 40)
                .join(" ")
                .trim(),
            image: eventGroupHasCoverImage
                ? `https://${res.locals.config?.general.domain}/events/` +
                  eventGroup.image
                : null,
            url:
                `https://${res.locals.config?.general.domain}/` +
                req.params.eventID,
        };

        res.set("X-Robots-Tag", "noindex");
        res.render("eventgroup", {
            ...frontendConfig(res),
            domain: res.locals.config?.general.domain,
            title: eventGroup.name,
            eventGroupData: eventGroup,
            escapedName: escapedName,
            upcomingEvents: upcomingEventsInMonthBuckets,
            pastEvents: pastEventsInMonthBuckets,
            parsedDescription: parsedDescription,
            editingEnabled: editingEnabled,
            eventGroupHasCoverImage: eventGroupHasCoverImage,
            eventGroupHasHost: eventGroupHasHost,
            firstLoad: firstLoad,
            metadata: metadata,
            jsonData: {
                name: eventGroup.name,
                id: eventGroup.id,
                description: eventGroup.description,
                url: eventGroup.url,
                hostName: eventGroup.hostName,
                creatorEmail: eventGroup.creatorEmail,
                image: eventGroup.image,
                editToken: editingEnabled ? eventGroupEditToken : null,
                showOnPublicList: eventGroup.showOnPublicList,
            },
        });
    } catch (err) {
        addToLog(
            "displayEventGroup",
            "error",
            `Attempt to display event group ${req.params.eventGroupID} failed with error: ${err}`,
        );
        console.log(err);
        return res.status(404).render("404", frontendConfig(res));
    }
});

router.get(
    "/group/:eventGroupID/feed.ics",
    async (req: Request, res: Response) => {
        try {
            const eventGroup = await EventGroup.findOne({
                id: req.params.eventGroupID,
            }).lean();

            if (eventGroup) {
                const events = await Event.find({
                    eventGroup: eventGroup._id,
                }).sort("start");
                const string = exportIcal(events, eventGroup.name);
                res.set("Content-Type", "text/calendar").send(string);
            }
        } catch (err) {
            addToLog(
                "eventGroupFeed",
                "error",
                `Attempt to display event group feed for ${req.params.eventGroupID} failed with error: ${err}`,
            );
            console.log(err);
            return res.status(404).render("404", frontendConfig(res));
        }
    },
);

router.get("/export/event/:eventID", async (req: Request, res: Response) => {
    try {
        const event = await Event.findOne({
            id: req.params.eventID,
        }).populate("eventGroup");

        if (event) {
            const string = exportIcal([event], event.name);
            res.set("Content-Type", "text/calendar").send(string);
        }
    } catch (err) {
        addToLog(
            "exportEvent",
            "error",
            `Attempt to export event ${req.params.eventID} failed with error: ${err}`,
        );
        console.log(err);
        return res.status(404).render("404", frontendConfig(res));
    }
});

router.get(
    "/export/group/:eventGroupID",
    async (req: Request, res: Response) => {
        try {
            const eventGroup = await EventGroup.findOne({
                id: req.params.eventGroupID,
            }).lean();

            if (eventGroup) {
                const events = await Event.find({
                    eventGroup: eventGroup._id,
                }).sort("start");
                const string = exportIcal(events, eventGroup.name);
                res.set("Content-Type", "text/calendar").send(string);
            }
        } catch (err) {
            addToLog(
                "exportEvent",
                "error",
                `Attempt to export event group ${req.params.eventGroupID} failed with error: ${err}`,
            );
            console.log(err);
            return res.status(404).render("404", frontendConfig(res));
        }
    },
);

export default router;
