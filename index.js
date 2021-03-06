const config = require("./config")

const TelegramBot = require("node-telegram-bot-api")
const bot = new TelegramBot(config.botToken, { polling: true })

const Parser = require("rss-parser")
const parser = new Parser()

const RssFeedEmitter = require("rss-feed-emitter")
const feeder = new RssFeedEmitter({ skipFirstLoad: true })

const striptags = require("striptags")

const uuidv4 = require("uuid").v4

const PrismaClient = require("@prisma/client").PrismaClient
const prisma = new PrismaClient()

let currentActions = {}

initializeFeedListener()

async function initializeFeedListener() {
	feeder.on('error', console.error);

	const feeds = await prisma.feed.findMany()

	for (const feed of feeds) startFeedListener(feed)
}

async function startFeedListener(feed) {
    console.log(`Added feed ${ feed.title }`)

	const uuid = uuidv4()

	feeder.add({
		url: feed.url,
		eventName: uuid,
	})

	feeder.on(uuid, (item) => emitToRecipients(item, feed))
}

async function stopFeedListener(feed) {
    console.log(`Removed feed ${ feed.title }`)
	feeder.remove(feed.url)
}

async function emitToRecipients(item, feed) {
    console.log(`Received message from feed ${ feed.title } with guid ${ item.guid }`)

	const recipients = await prisma.recipient.findMany({
		where: {
			feed: {
				id: feed.id,
			},
		},
	})

    const insertPayload = []

	for (const recipient of recipients) {
		const canSend =
			(await prisma.receivedMessage.findFirst({
				where: {
					recipientId: recipient.id,
					guid: item.guid,
				},
			})) == null && matchesFilter(recipient, item)

        if(canSend) {
            await sendToRecipient(recipient.chatId, recipient.title, item)
            insertPayload.push({
                recipientId: recipient.id,
                guid: item.guid 
            })
        }
	}

    await prisma.receivedMessage.createMany({
        data: insertPayload
    })
}

function matchesFilter(recipient, item) {
	const filters = JSON.parse(recipient.filters)

	if(filters.length === 0) return true

	const title = (item.title || "").toLowerCase()
	const description = striptags(item.summary || item.description || item.content || "").toLowerCase()
	const link = (item.link || "").toLowerCase()

	for(const _filter of filters) {
		const filter = _filter.toLowerCase()

		if(title.indexOf(filter) !== -1) return true
		if(description.indexOf(filter) !== -1) return true
		if(link.indexOf(filter) !== -1) return true
	}

	return false
}

async function sendToRecipient(chatId, customTitle, item) {

	const title = item.title || "Ohne Titel"
	const description = striptags(
		item.summary || item.description || item.content || "Ohne Beschreibung"
	)
	const link = item.link || "Ohne Link"

	bot.sendMessage(
		chatId,
		`*${title}*\n\n${description}\n\n${link} (${customTitle})`,
		{
			parse_mode: "Markdown",
		}
	)
}

async function parseFeedUrl(url) {
	const result = await parser.parseURL(url)
	if(!result.title) result.title = url
	return result
}

async function addFeed(chatId, url, feed, customName = null, filters = []) {
	const name = customName ? customName : feed.title

    let feedEntry = await prisma.feed.findFirst({
        where: {
            url: url
        }
    })

    if(!feedEntry) {
        feedEntry = await prisma.feed.create({
            data: {
                url: url,
                title: feed.title
            }
        })

        startFeedListener(feedEntry)
    }

	await prisma.recipient.create({
		data: {
			chatId: chatId,
			feedId: feedEntry.id,
			title: name,
			filters: JSON.stringify(filters)
		},
	})

	bot.sendMessage(
		chatId,
		`Ich habe *${name}* hinzugef??gt. Ab jetzt wirst du ??ber neue Nachrichten automatisch benachrichtigt. Die Daten werden alle 60 Sekunden abgeglichen.`,
		{
			parse_mode: "Markdown",
		}
	)

	delete currentActions[chatId]
}

async function removeFeedFromDatabase(id) {
	const feed = await prisma.feed.findUnique({
		where: {
			id: id,
		},
	})

	stopFeedListener(feed)

	await prisma.feed.delete({
		where: {
			id: id,
		},
	})
}

async function removeFeed(chatId, id, name) {
	const recipient = await prisma.recipient.findFirst({
		where: {
			chatId: chatId,
			feed: {
				id: id,
			},
		},
	})

    await prisma.receivedMessage.deleteMany({
        where: {
            recipientId: recipient.id
        }
    })

	await prisma.recipient.delete({
		where: {
			id: recipient.id,
		},
	})

	const isFeedInUse =
		(await prisma.recipient.findFirst({
			where: {
				feed: {
					id: id,
				},
			},
		})) != null

	if (!isFeedInUse) removeFeedFromDatabase(id)

	bot.sendMessage(chatId, `Ich habe *${name}* entfernt.`, {
		parse_mode: "Markdown",
	})

	delete currentActions[chatId]
}

async function removeAllFeeds(chatId) {
	const recipientFeeds = await prisma.recipient.findMany({
		where: {
			chatId: chatId,
		},
	})

    for(const recipientFeed of recipientFeeds)
        await prisma.receivedMessage.deleteMany({
            where: {
                recipientId: recipientFeed.id
            }
        })

	await prisma.recipient.deleteMany({
		where: {
			chatId: chatId,
		},
	})

	for (const recipientFeed of recipientFeeds) {
		const isFeedInUse =
			(await prisma.recipient.findFirst({
				where: {
					feed: {
						id: recipientFeed.feedId,
					},
				},
			})) != null

		if (!isFeedInUse) removeFeedFromDatabase(recipientFeed.feedId)
	}

	bot.sendMessage(chatId, `Ich habe alle Feeds entfernt.`, {
		parse_mode: "Markdown",
	})

	delete currentActions[chatId]
}

async function isSubscribedToFeed(chatId, url) {
	const result = await prisma.recipient.findFirst({
		where: {
			chatId: chatId,
			feed: {
				url: url,
			},
		},
	})

	return result != null
}

bot.onText(/\/start/, (message) => {
	bot.sendMessage(
		message.chat.id,
		`Hallo ${message.chat.first_name},\num einen Feed hinzuzuf??gen, gib /addfeed ein. Um einen zu entfernen /remfeed und um alle Feeds zu entfernen /stop.\n\nErstellt von l9cgv`
	)
})

bot.onText(/\/addfeed/, (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId] && currentActions[chatId].type === "addfeed")
		return bot.sendMessage(
			chatId,
			"Du bist bereits dabei einen neuen Feed hinzuzuf??gen. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)
	else if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			"Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)

	currentActions[chatId] = {
		type: "addfeed",
		section: "url",
	}

	bot.sendMessage(chatId, "Alles klar. Sende mir nun die URL des RSS Feeds.")
})

bot.onText(/\/remfeed/, async (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId] && currentActions[chatId].type === "addfeed")
		return bot.sendMessage(
			chatId,
			"Du bist bereits dabei einen Feed zu entfernen. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)
	else if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			"Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)

	currentActions[chatId] = {
		type: "remfeed",
		section: "type",
	}

	const feeds = await prisma.recipient.findMany({
		where: {
			chatId: chatId,
		},
	})

	if (feeds.length === 0)
		return bot.sendMessage(chatId, "Du hast noch keine Feeds abonniert.")

	const items = []

	for (const feed of feeds) items.push([{ text: feed.title }])

	bot.sendMessage(
		chatId,
		"Bitte w??hle einen Feed aus, den du entfernen m??chtest...",
		{
			reply_markup: {
				keyboard: items,
				one_time_keyboard: true,
			},
		}
	)
})

bot.onText(/\/feeds/, async (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			"Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)

	const feeds = await prisma.recipient.findMany({
		where: {
			chatId: chatId,
		},
	})

	if (feeds.length === 0)
		return bot.sendMessage(chatId, "Du hast noch keine Feeds abonniert.")

	const items = []

	for (const feed of feeds) {
		let name = `*${feed.title}*`
		const filters = JSON.parse(feed.filters)

		if(filters.length > 0)
			name += ` - Gefiltert mit ${ filters.join(', ') }`

		items.push(name)
	}

	bot.sendMessage(
		chatId,
		`Du hast folgende Feeds abonniert:\n\n${items.join("\n")}`,
		{
			parse_mode: "Markdown",
		}
	)
})

bot.onText(/\/stop/, async (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId] && currentActions[chatId].type === "addfeed")
		return bot.sendMessage(
			chatId,
			"Du bist bereits dabei alle Feeds zu entfernen. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)
	else if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			"Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen m??chtest, so gib /cancel ein."
		)

	const feeds = await prisma.recipient.findMany({
		where: {
			chatId: chatId,
		},
	})

	currentActions[chatId] = {
		type: "stop",
		section: "confirm",
	}

	if (feeds.length === 0)
		return bot.sendMessage(chatId, "Du hast noch keine Feeds abonniert.")

	bot.sendMessage(
		chatId,
		`Du bist dabei ${feeds.length} Feeds zu l??schen. M??htest du fortfahren?`,
		{
			reply_markup: {
				keyboard: [
					[
						{
							text: "Ja",
						},
						{
							text: "Nein",
						},
					],
					[
						{
							text: "Abbrechen",
						},
					],
				],
				one_time_keyboard: true,
			},
		}
	)
})

bot.onText(/(\/cancel)|Abbrechen/, (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId]) {
		delete currentActions[chatId]
		bot.sendMessage(chatId, "Aktueller Prozess wurde abgebrochen.")
	} else bot.sendMessage(chatId, "Es gibt nichts zum Abbrechen.")
})

bot.on("message", async (message) => {
	const chatId = message.chat.id

	if (message.text && message.text.indexOf("/cancel") === 0) return

	if (currentActions[chatId] && currentActions[chatId].type === "addfeed") {
		switch (currentActions[chatId].section) {
			case "url":
				{
					if (await isSubscribedToFeed(chatId, message.text))
						return bot.sendMessage(
							chatId,
							"Du hast diesen Feed bereits abonniert. Gib eine andere URL ein oder breche mit /cancel ab."
						)

					bot.sendMessage(
						chatId,
						"Ich pr??fe nun die URL, warte einen Moment..."
					)

					try {
						const feed = await parseFeedUrl(message.text)

						bot.sendMessage(
							chatId,
							`Ich habe einen Feed names *${
								feed.title || "Unbekannter Name"
							}* (${
								feed.link || ""
							}) gefunden.\n\nM??chtest Du diesen Feed hinzuf??gen?`,
							{
								parse_mode: "Markdown",
								reply_markup: {
									keyboard: [
										[
											{
												text: "Ja",
											},
											{
												text: "Nein",
											},
										],
										[
											{
												text: "Abbrechen",
											},
										],
									],
									one_time_keyboard: true,
								},
							}
						)

						currentActions[chatId].section = "add"
						currentActions[chatId].feed = {
							url: message.text,
							data: feed,
						}
					} catch (e) {
						bot.sendMessage(
							chatId,
							"Das scheint eine ung??ltige URL zu sein. Bitte versuche es nochmal oder gib /cancel zum Abbrechen ein."
						)
					}
				}
				break
			case "add":
				{
					switch (message.text) {
						case "Ja":
							{
								bot.sendMessage(
									chatId,
									`M??chtest du den Namen *${currentActions[chatId].feed.data.title}* beibehalten oder ??ndern?`,
									{
										parse_mode: "Markdown",
										reply_markup: {
											keyboard: [
												[
													{
														text: "Namen beibehalten",
													},
													{
														text: "Namen ??ndern",
													},
												],
												[
													{
														text: "Abbrechen",
													},
												],
											],
											one_time_keyboard: true,
										},
									}
								)

								currentActions[chatId].section = "name"
							}
							break
						case "Nein":
							{
								bot.sendMessage(
									chatId,
									"In Ordnung. Sende mir eine neue URL oder gib /cancel zum Abbrechen ein."
								)
								currentActions[chatId].section = "url"
							}
							break
						case "Abbrechen":
							break
						default: {
							bot.sendMessage(
								chatId,
								'Ung??ltige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel'
							)
						}
					}
				}
				break
			case "name":
				{
					switch (message.text) {
						case "Namen beibehalten":
							{
								// await addFeed(
								// 	chatId,
								// 	currentActions[chatId].feed.url,
								// 	currentActions[chatId].feed.data
								// )

								bot.sendMessage(
									chatId,
									`M??chtest du die Ergebnisse filtern?`,
									{
										parse_mode: "Markdown",
										reply_markup: {
											keyboard: [
												[
													{
														text: "Ja",
													},
													{
														text: "Nein",
													},
												],
												[
													{
														text: "Abbrechen",
													},
												],
											],
											one_time_keyboard: true,
										},
									}
								)
								
								currentActions[chatId].section = "requestFilters"
							}
							break
						case "Namen ??ndern": {
							bot.sendMessage(
								chatId,
								`Bitte sende mir einen anderen Namen f??r *${currentActions[chatId].feed.data.title}*`,
								{
									parse_mode: "Markdown",
								}
							)

							currentActions[chatId].section = "customName"
						}
						case "Abbrechen":
							break
						default: {
							bot.sendMessage(
								chatId,
								'Ung??ltige Eingabe. Erlaubt sind "Namen beibehalten", "Namen ??ndern", "Abbrechen" und /cancel'
							)
						}
					}
				}
				break
			case "customName": {
				if (message.text <= 0)
					bot.sendMessage(
						chatId,
						'Ung??ltige Eingabe. Bitte sende mir einen Namen. Wenn du den Namen nicht ??ndern willst, so sende mir "Namen beibehalten" oder gib /cancel zum abbrechen ein.'
					)
				else {
					if(message.text !== "Namen beibehalten")
						currentActions[chatId].feed.title = message.text

					bot.sendMessage(
						chatId,
						`M??chtest du die Ergebnisse filtern?`,
						{
							parse_mode: "Markdown",
							reply_markup: {
								keyboard: [
									[
										{
											text: "Ja",
										},
										{
											text: "Nein",
										},
									],
									[
										{
											text: "Abbrechen",
										},
									],
								],
								one_time_keyboard: true,
							},
						}
					)
								
					currentActions[chatId].section = "requestFilters"
				}
			} break
			case "requestFilters": {
				switch (message.text) {
					case "Ja":
						{
							bot.sendMessage(chatId, `Sende mir alle zu filternde Begriffe getrennt mit Komma. Wenn du keine Filter einstellen willst, so sende mir ein Minus (-)\n\n(Beispiel: Wetter, Klima, Regen, Sonne, Hitze)`)
							currentActions[chatId].section = "filters"
						}
						break
					case "Nein":
						{
							await addFeed(
								chatId,
								currentActions[chatId].feed.url,
								currentActions[chatId].feed.data,
								currentActions[chatId].feed.title
							)
						}
						break
					case "Abbrechen":
						break
					default: {
						bot.sendMessage(
							chatId,
							'Ung??ltige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel'
						)
					}
				}
			} break
			case "filters": {
				if(message.text === "-")
					await addFeed(
						chatId,
						currentActions[chatId].feed.url,
						currentActions[chatId].feed.data,
						currentActions[chatId].feed.title
					)
				else {
					const filters = []

					for(const filter of message.text.split(','))
						filters.push(filter.trim())

					await addFeed(
						chatId,
						currentActions[chatId].feed.url,
						currentActions[chatId].feed.data,
						currentActions[chatId].feed.title,
						filters
					)
				}
			}
		}
	} else if (
		currentActions[chatId] &&
		currentActions[chatId].type === "remfeed"
	) {
		switch (currentActions[chatId].section) {
			case "type":
				{
					const feed = await prisma.recipient.findFirst({
						where: {
							chatId: chatId,
							title: message.text,
						},
					})

					if (!feed)
						return bot.sendMessage(
							chatId,
							"Ung??ltiger Feed. Bitte gib einen vorhandenen Feed an oder breche mit /cancel ab."
						)

					bot.sendMessage(
						chatId,
						`M??chtest du den Feed names *${feed.title}* wirklich l??schen?`,
						{
							parse_mode: "Markdown",
							reply_markup: {
								keyboard: [
									[
										{
											text: "Ja",
										},
										{
											text: "Nein",
										},
									],
									[
										{
											text: "Abbrechen",
										},
									],
								],
								one_time_keyboard: true,
							},
						}
					)

					currentActions[chatId].section = "confirm"
					currentActions[chatId].feed = feed
				}
				break
			case "confirm": {
				switch (message.text) {
					case "Ja":
						{
							await removeFeed(
								chatId,
								currentActions[chatId].feed.id,
								currentActions[chatId].feed.title
							)
						}
						break
					case "Nein":
						{
							bot.sendMessage(
								chatId,
								"In Ordnung. Ich habe den Vorgang abgebrochen."
							)
							delete currentActions[chatId]
						}
						break
					case "Abbrechen":
						break
					default: {
						bot.sendMessage(
							chatId,
							'Ung??ltige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel'
						)
					}
				}
			}
		}
	} else if (
		currentActions[chatId] &&
		currentActions[chatId].type === "stop"
	) {
		switch (currentActions[chatId].section) {
			case "confirm": {
				switch (message.text) {
					case "Ja":
						{
							await removeAllFeeds(chatId)
						}
						break
					case "Nein":
						{
							bot.sendMessage(
								chatId,
								"In Ordnung. Ich habe den Vorgang abgebrochen."
							)
							delete currentActions[chatId]
						}
						break
					case "Abbrechen":
						break
					default: {
						bot.sendMessage(
							chatId,
							'Ung??ltige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel'
						)
					}
				}
			}
		}
	}
})
