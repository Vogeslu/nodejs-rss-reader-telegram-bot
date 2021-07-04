const config = require('./config')

const TelegramBot = require('node-telegram-bot-api')
const bot = new TelegramBot(config.botToken, { polling: true })

const Parser = require('rss-parser')
const parser = new Parser()

const fs = require('fs')
const util = require('util')

const striptags = require('striptags')

const uuidv4 = require('uuid').v4

const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)


let currentActions = {}

let data = {
    feeds: {},
    recipients: {}
}

async function initialize() {
    try {
        data = JSON.parse(await readFile('data.json', 'utf8'))
    } catch(e) {
        await writeFile('data.json', JSON.stringify(data), 'utf8')
    }


    await checkForUpdates()

    setInterval(async () => await writeFile('data.json', JSON.stringify(data), 'utf8'), 30 * 1000)
    setInterval(async () => await checkForUpdates(), 10 * 1000)
}

async function checkForUpdates() {
    const now = Date.now()
    for(const [uuid, feed] of Object.entries(data.feeds)) {
        if(feed.lastUpdated === null || (feed.lastUpdated + (60 * 1000)) < now) {
            try {
                await getFeedDataAndEmit(uuid)
                feed.lastUpdated = now
            } catch(e) {}
        }
    }
}

initialize()

async function parseFeedUrl(url) {
	return await parser.parseURL(url)
}

async function addFeed(chatId, url, feed, customName = null) {
    const name = customName ? customName : feed.title

    const recipientData = data.recipients[chatId] || { feeds: [] }

    let existingFeedUUID = searchForExistingFeed(url)
    if(!existingFeedUUID) {
        existingFeedUUID = uuidv4()

        data.feeds[existingFeedUUID] = {
            url: url,
            title: feed.title,
            lastUpdated: null
        }
    }

    recipientData.feeds.push({
        uuid: existingFeedUUID,
        title: name,
        lastMessage: null,
        fromSetup: true
    })

    data.recipients[chatId] = recipientData

    await writeFile('data.json', JSON.stringify(data), 'utf8')

    bot.sendMessage(chatId, `Ich habe *${ name }* hinzugefügt. Ab jetzt wirst du über neue Nachrichten automatisch benachrichtigt. Die Daten werden alle 60 Sekunden abgeglichen.`, {
        parse_mode: 'Markdown'
    })

    delete currentActions[chatId]
}

async function removeFeed(chatId, uuid, name) {
    const recipientData = data.recipients[chatId] || { feeds: [] }

    let index = -1

    for(let i in recipientData.feeds)
        if(recipientData.feeds[i].uuid === uuid)
            index = i

    if(index !== -1)
        recipientData.feeds.splice(index, 1)

    data.recipients[chatId] = recipientData

    let isFeedInUse = false
    for(const recipient of Object.values(data.recipients))
        for(const feed of recipient.feeds)
            if(feed.uuid === uuuid)
                isFeedInUse = true

    if(!isFeedInUse) delete data.feeds[uuid]

    await writeFile('data.json', JSON.stringify(data), 'utf8')

    bot.sendMessage(chatId, `Ich habe *${ name }* entfernt.`, {
        parse_mode: 'Markdown'
    })

    delete currentActions[chatId]
}

function searchForExistingFeed(url) {
    let existingFeed = null

    for(const [uuid, feed] of Object.entries(data.feeds))
        if(feed.url === url)
            existingFeed = uuid
    
    return existingFeed
}

function isSubscribedToFeed(chatId, url) {
    const existingFeedUUID = searchForExistingFeed(url)
    if(!existingFeedUUID) return false

    const recipientData = data.recipients[chatId] || { feeds: [] }

    for(const feed of recipientData.feeds)
        if(feed.uuid === existingFeedUUID) return true

    return false
}

async function getFeedDataAndEmit(uuid) {
    const feed = data.feeds[uuid];

    try {
        console.log(`Parsing ${ feed.url }`)
        const feedData = await parseFeedUrl(feed.url)

        for(const [chatId, recipient] of Object.entries(data.recipients))
            for(const _feed of recipient.feeds)
                if(_feed.uuid === uuid)
                    emitStackToRecipient(feedData, recipient, chatId, _feed)
    } catch(e) {

    }
}

async function emitStackToRecipient(feed, recipient, chatId, recipientFeed) {
    if(recipientFeed.fromSetup) {
        recipientFeed.fromSetup = false
        recipientFeed.lastMessage = Date.now()
    } else {
        let relevantMessages = []

        for(const item of feed.items) {
            const pubDate = Date.parse(item.pubDate)

            if(pubDate > recipientFeed.lastMessage)
                relevantMessages.push(item)
        }

        for(const item of relevantMessages)
            sendToRecipient(chatId, recipientFeed, item)

        recipientFeed.lastMessage = Date.now()
    }
}

function sendToRecipient(chatId, recipientFeed, item) {
    const title = item.title || 'Ohne Titel'
    const description = striptags(item.description || item.content || 'Ohne Beschreibung')
    const link = item.link || 'Ohne Link'

    bot.sendMessage(chatId, `*${ title }*\n\n${ description }\n\n${ link } (${ recipientFeed.title })`, {
        parse_mode: 'Markdown'
    })
}

bot.onText(/\/start/, (message) => {
	bot.sendMessage(
		message.chat.id,
		`Hallo ${message.chat.first_name},\num einen Feed hinzuzufügen, gib /addfeed ein. Um einen zu entfernen /remfeed und um alle Feeds zu entfernen /stop.\n\nErstellt von l9cgv`
	)
})

bot.onText(/\/addfeed/, (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId] && currentActions[chatId].type === 'addfeed')
		return bot.sendMessage(
			chatId,
			'Du bist bereits dabei einen neuen Feed hinzuzufügen. Wenn du den aktuellen Prozess abbrechen möchtest, so gib /cancel ein.'
		)
	else if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			'Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen möchtest, so gib /cancel ein.'
		)

	currentActions[chatId] = {
        type: 'addfeed',
        section: 'url'
    }

    bot.sendMessage(chatId, 'Alles klar. Sende mir nun die URL des RSS Feeds.')
})

bot.onText(/\/remfeed/, (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId] && currentActions[chatId].type === 'addfeed')
		return bot.sendMessage(
			chatId,
			'Du bist bereits dabei einen Feed zu entfernen. Wenn du den aktuellen Prozess abbrechen möchtest, so gib /cancel ein.'
		)
	else if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			'Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen möchtest, so gib /cancel ein.'
		)

    currentActions[chatId] = {
        type: 'remfeed',
        section: 'type'
    }

    const recipientData = data.recipients[chatId] || { feeds: [] }

    if(recipientData.feeds.length === 0)
        return bot.sendMessage(chatId, 'Du hast noch keine Feeds abonniert.')

    const items = []

    for(const feed of recipientData.feeds)
        items.push([{ text: feed.title }])

    bot.sendMessage(chatId, 'Bitte wähle einen Feed aus, den du entfernen möchtest...', {
        reply_markup: {
            keyboard: items,
            one_time_keyboard: true
        }
    })
})

bot.onText(/\/feeds/, (message) => {
	const chatId = message.chat.id

    if (currentActions[chatId])
		return bot.sendMessage(
			chatId,
			'Du bist aktuell noch in einem anderen Prozess. Wenn du den aktuellen Prozess abbrechen möchtest, so gib /cancel ein.'
		)

    const recipientData = data.recipients[chatId] || { feeds: [] }

    if(recipientData.feeds.length === 0)
        return bot.sendMessage(chatId, 'Du hast noch keine Feeds abonniert.')

    const items = []

    for(const feed of recipientData.feeds) {
        const feedData = data.feeds[feed.uuid]
        items.push(`*${ feed.title }*`)
    }

    bot.sendMessage(chatId, `Du hast folgende Feeds abonniert:\n\n${ items.join('\n') }`, {
        parse_mode: 'Markdown'
    })
})

bot.onText(/(\/cancel)|Abbrechen/, (message) => {
	const chatId = message.chat.id

	if (currentActions[chatId]) {
		delete currentActions[chatId]
		bot.sendMessage(chatId, 'Aktueller Prozess wurde abgebrochen.')
	} else bot.sendMessage(chatId, 'Es gibt nichts zum Abbrechen.')
})


bot.on('message', async (message) => {
	const chatId = message.chat.id

    if(message.text && message.text.indexOf('/cancel') === 0) return

    if(currentActions[chatId] && currentActions[chatId].type === 'addfeed') {

        switch(currentActions[chatId].section) {
            case 'url': {
                if(isSubscribedToFeed(chatId, message.text))
                    return bot.sendMessage(chatId, 'Du hast diesen Feed bereits abonniert. Gib eine andere URL ein oder breche mit /cancel ab.')

                bot.sendMessage(chatId, 'Ich prüfe nun die URL, warte einen Moment...')

                try {
                    const feed = await parseFeedUrl(message.text)
                    
                    bot.sendMessage(chatId, `Ich habe einen Feed names *${feed.title || 'Unbekannter Name'}* (${ feed.link || '' }) gefunden.\n\nMöchtest Du diesen Feed hinzufügen?`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                [
                                    {
                                        text: 'Ja'
                                    },
                                    {
                                        text: 'Nein'
                                    }
                                ],
                                [
                                    {
                                        text: 'Abbrechen'
                                    }
                                ]
                            ],
                            one_time_keyboard: true
                        }
                    })

                    currentActions[chatId].section = 'add'
                    currentActions[chatId].feed = {
                        url: message.text,
                        data: feed
                    }
                } catch(e) {
                    bot.sendMessage(chatId, 'Das scheint eine ungültige URL zu sein. Bitte versuche es nochmal oder gib /cancel zum Abbrechen ein.')
                }
            } break
            case 'add': {
                switch(message.text) {
                    case 'Ja': {
                        bot.sendMessage(chatId, `Möchtest du den Namen *${ currentActions[chatId].feed.data.title }* beibehalten oder ändern?`, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                keyboard: [
                                    [
                                        {
                                            text: 'Namen beibehalten'
                                        },
                                        {
                                            text: 'Namen ändern'
                                        }
                                    ],
                                    [
                                        {
                                            text: 'Abbrechen'
                                        }
                                    ]
                                ],
                                one_time_keyboard: true
                            }
                        })

                        currentActions[chatId].section = 'name'
                    } break
                    case 'Nein': {
                        bot.sendMessage(chatId, 'In Ordnung. Sende mir eine neue URL oder gib /cancel zum Abbrechen ein.')
                        currentActions[chatId].section = 'url'
                    } break
                    case 'Abbrechen': break
                    default: {
                        bot.sendMessage(chatId, 'Ungültige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel')
                    }
                }
            } break
            case 'name': {
                switch(message.text) {
                    case 'Namen beibehalten': {
                        await addFeed(chatId, currentActions[chatId].feed.url, currentActions[chatId].feed.data)
                    } break
                    case 'Namen ändern': {
                        bot.sendMessage(chatId, `Bitte sende mir einen anderen Namen für *${ currentActions[chatId].feed.data.title }*`, {
                            parse_mode: 'Markdown'
                        })

                        currentActions[chatId].section = 'customName'
                    }
                    case 'Abbrechen': break
                    default: {
                        bot.sendMessage(chatId, 'Ungültige Eingabe. Erlaubt sind "Namen beibehalten", "Namen ändern", "Abbrechen" und /cancel')
                    }
                }
            } break
            case 'customName': {
                if(message.text <= 0)
                    bot.sendMessage(chatId, 'Ungültige Eingabe. Bitte sende mir einen Namen. Wenn du den Namen nicht ändern willst, so sende mir "Namen beibehalten" oder gib /cancel zum abbrechen ein.')
                else if(message.text === 'Namen beibehalten')
                await addFeed(chatId, currentActions[chatId].feed.url, currentActions[chatId].feed.data)
                else
                    await addFeed(chatId, currentActions[chatId].feed.url, currentActions[chatId].feed.data, message.text)
            }
        }
    } else if(currentActions[chatId] && currentActions[chatId].type === 'remfeed') {
        switch(currentActions[chatId].section) {
            case 'type': {
                let target = null

                const recipientData = data.recipients[chatId] || { feeds: [] }

                for(const feed of recipientData.feeds)
                    if(feed.title === message.text)
                        target = feed

                if(!target)
                    return bot.sendMessage(chatId, 'Ungültiger Feed. Bitte gib einen vorhandenen Feed an oder breche mit /cancel ab.')

                    bot.sendMessage(chatId, `Möchtest du den Feed names *${target.title}* wirklich löschen?`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                [
                                    {
                                        text: 'Ja'
                                    },
                                    {
                                        text: 'Nein'
                                    }
                                ],
                                [
                                    {
                                        text: 'Abbrechen'
                                    }
                                ]
                            ],
                            one_time_keyboard: true
                        }
                    })

                    currentActions[chatId].section = 'confirm'
                    currentActions[chatId].feed = target
            } break
            case 'confirm': {
                switch(message.text) {
                    case 'Ja': {
                        await removeFeed(chatId, currentActions[chatId].feed.uuid, currentActions[chatId].feed.title)
                    } break
                    case 'Nein': {
                        bot.sendMessage(chatId, 'In Ordnung. Ich habe den Vorgang abgebrochen.')
                        delete currentActions[chatId]
                    } break
                    case 'Abbrechen': break
                    default: {
                        bot.sendMessage(chatId, 'Ungültige Eingabe. Erlaubt sind "Ja", "Nein", "Abbrechen" und /cancel')
                    }
                }
            }
        }
    }
})