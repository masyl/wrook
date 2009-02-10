#!python
# coding=UTF-8

# The following imports are probably not needed anymore... investigate
#import os
#os.environ['DJANGO_SETTINGS_MODULE'] = 'settings'
#from django.conf import settings

from feathers import webapp
from feathers import membership

def URLMappings():
	return [
		( '/', Home),
		( '/Members', Members),
		(r'/Members/(.*)/Covers', MembersCoversList),
		(r'/Members/(.*)/Books', MembersBooksList),
		(r'/Members/(.*)/Bookmarks', MembersBookmarks),
		(r'/Members/(.*)/Neighborhood', MembersNeighborhood),
		(r'/Members/(.*)/Feed/RSS', MembersFeedRSS),
		(r'/Members/(.*)/Feed', MembersFeed),
		(r'/Members/(.*)/Follow', MembersFollow),
		(r'/Members/(.*)/StopFollowing', MembersStopFollowing),
		(r'/Members/(.*)', MembersProfile),
		( '/Customize/Wallpapers/List/JSON', CustomizeWallpapersListJSON),
		( '/Customize/Wallpapers', CustomizeWallpapers),
		( '/Customize', Customize),
		( '/Suggestions', Suggestions)]


class Home(webapp.RequestHandler):
	def get(self):
		from google.appengine.api import memcache
		onRequest(self)
		if self.CurrentMember:
			self.setVisitedMember(self.CurrentMember)
			BeginnerBook = []
			BeginnerBookmark = []
			
			cacheKey = "wrookMemberPosts-%s" % self.CurrentMember.key()
			posts = memcache.get(cacheKey)
			if not posts:
				posts = self.CurrentMember.ReceivedStoryPosts.order("-WhenOccured").fetch(limit=50)
				memcache.add(cacheKey, posts)
			
			self.Model.update({
				"posts": posts
				})
			self.render2('views/memberHome.html')
		else:
			self.render2('views/visitorHome.html')

class MembersFeedRSS(webapp.RequestHandler):
	def get(self, key):
		import datetime
		import PyRSS2Gen
		onRequest(self)
		member = membership.Member.get(key)
		if member:
			self.setVisitedMember(member)
			posts = member.ReceivedStoryPosts.order("-WhenOccured").filter("Member = ", member.key()).fetch(limit=40)
			rssItems = []
			for post in posts:
				rssItems.extend([
					PyRSS2Gen.RSSItem(
						title = post.Title,
						link = "http://www.wrook.org/Members/%s/Feed" % self.VisitedMember.key(),
						description = post.Body,
						guid = PyRSS2Gen.Guid("http://www.wrook.org/guid/%s" % post.key()),
						pubDate = post.WhenOccured
					)])
			rss = PyRSS2Gen.RSS2(
				title = "%s at Wrook.org" % self.VisitedMember.fullname(),
				link = "http://www.wrook.org/Members/%s/Feed" % self.VisitedMember.key(),
				description = "",
				lastBuildDate = datetime.datetime.now(),
				items = rssItems
				)
			self.response.headers['content-type'] = "application/rss+xml"
			self.response.out.write(rss.to_xml())
		else: self.error(404)

class MembersFeed(webapp.RequestHandler):
	def get(self, key):
		onRequest(self)
		member = membership.Member.get(key)
		if member:
			self.setVisitedMember(member)
			posts = member.ReceivedStoryPosts.order("-WhenOccured").filter("Member = ", member.key()).fetch(limit=40)
			self.Model.update({
				"posts": posts
				})
			self.render2('views/members-stories.html')
		else: self.error(404)

class Customize(webapp.RequestHandler):
	def get(self):
		from feathers import customize
		import books
		onRequest(self)
		if self.CurrentMember:
			self.render2("views/customize.html")

class CustomizeWallpapers(webapp.RequestHandler):
	def get(self):
		from feathers import customize
		import books
		onRequest(self)
		if self.CurrentMember:
			self.Model.update({
				"latestThemes": customize.Theme.all().order("-Created").fetch(limit=20)
				})
			self.render2("views/customize-wallpapers.html")

class CustomizeWallpapersListJSON(webapp.RequestHandler):
	def get(self):
		from feathers import customize
		from django.utils import simplejson
		import books
		onRequest(self)
		if self.CurrentMember:
			offset = int(self.request.get("offset"))
			limit = int(self.request.get("limit"))
			if offset < 300:
				if limit > 50: limit = 50
				themes = customize.Theme.all().order("-Created").fetch(limit=limit, offset=offset)
				wallpapers = []
				for theme in themes:
					wallpapers.append({
						"key": "%s" % theme.key(),
						"isTiled": theme.isTiled()
					})
				self.response.out.write("(%s)" % simplejson.dumps({"wallpapers": wallpapers}))

class Suggestions(webapp.RequestHandler):
	def get(self):
		onRequest(self)
		if self.CurrentMember:
			self.setVisitedMember(self.CurrentMember)
			self.render("views/member-suggestions.html")
		else: self.requestLogin()

class MembersProfile(webapp.RequestHandler):
	def get(self, key):
		from google.appengine.api import memcache
		import datetime
		onRequest(self)
		visitedMember = membership.Member.get(key)
		if visitedMember:
			self.setVisitedMember(visitedMember)
			cacheKey = "wrookMemberPosts-Preview-%s" % visitedMember.key()
			posts = memcache.get(cacheKey)
			if not posts:
				posts = visitedMember.ReceivedStoryPosts.order("-WhenOccured").fetch(limit=10)
				memcache.add(cacheKey, posts)
			self.Model.update({
				"now": datetime.datetime.now(),
				"posts": posts
				})
			self.render2('views/MembersProfile.html')
		else: self.error(404)

class MembersFollow(webapp.RequestHandler):
	def get(self, key):
		from django.utils import simplejson
		onRequest(self)
		member = membership.Member.get(key)
		if self.CurrentMember!=None and member!=None:
			newRelationship = self.CurrentMember.start_follower_relationship_with(member)
			if newRelationship:
				data = {"errorCode":0, "html": _("Done!")}
				self.response.out.write("(%s)" % simplejson.dumps(data))
			else:
				self.response.out.write(simplejson.dumps({
					"errorCode": 1,
					"errorMessage": _("An error occured! Sorry!")
					}))
		else:
			self.response.out.write(simplejson.dumps({
				"errorCode": 1,
				"errorMessage": _("An error occured! Sorry!")
				}))

class MembersStopFollowing(webapp.RequestHandler):
	def get(self, key):
		from django.utils import simplejson
		onRequest(self)
		member = membership.Member.get(key)
		if self.CurrentMember!=None and member!=None:
			result = self.CurrentMember.stop_follower_relationship_with(member)
			if result:
				data = {"errorCode":0, "html": _("Done!")}
				self.response.out.write("(%s)" % simplejson.dumps(data))
			else:
				self.response.out.write(simplejson.dumps({
					"errorCode": 1,
					"errorMessage": _("An error occured! Sorry!")
					}))
		else:
			self.response.out.write(simplejson.dumps({
				"errorCode": 1,
				"errorMessage": _("An error occured! Sorry!")
				}))

def get_featured_members():
	return membership.Member.all().filter("hasProfilePhoto =", True).fetch(limit=5)

def get_search_members(searchCriteria):
	import logging
	logging.debug("criteria: %s" % searchCriteria)
	return membership.Member.all().search(searchCriteria).fetch(limit=40)

class Members(webapp.RequestHandler):
	def get(self):
		onRequest(self)
		searchCriteria = self.request.get("searchCriteria")
		if searchCriteria: members = get_search_members(searchCriteria)
		else: members = get_featured_members()
		self.Model.update({
			'members': members,
			'searchCriteria': searchCriteria})
		self.render2('views/members.html')

class MembersCoversList(webapp.RequestHandler):
	def get(self, key):
		onRequest(self)
		visitedMember = membership.Member.get(key)
		if visitedMember:
			self.setVisitedMember(visitedMember)
			sharedCovers = visitedMember.Covers.filter("isSharedWithEveryone =", True).fetch(limit=100)
			privateCovers = visitedMember.Covers.filter("isSharedWithEveryone =", False).fetch(limit=100)
			permissionMemberCanSeePrivateCovers = self.CurrentMember.isAdmin or self.CurrentMember == self.VisitedMember
			self.Model.update({
				'sharedCovers': sharedCovers,
				'privateCovers': privateCovers,
				'permissionMemberCanSeePrivateCovers': permissionMemberCanSeePrivateCovers
				})
			self.render2('views/members-covers-list.html')
		else: self.error(404)

class MembersBooksList(webapp.RequestHandler):
	def get(self, key):
		onRequest(self)
		visitedMember = membership.Member.get(key)
		if visitedMember:
			self.setVisitedMember(visitedMember)
			books = visitedMember.Books.fetch(limit=999)
			hasEditRights = False # Getting rights should be refactored.. this is half-assed
			if (self.CurrentMember!=None) & (visitedMember!=None):
				hasEditRights = self.CurrentMember.isAdmin or self.CurrentMember == self.VisitedMember
			self.Model.update({
				'hasEditRights': hasEditRights,
				'books': books
				})
			self.render2('views/members-books-list.html')
		else: self.error(404)

class MembersBookmarks(webapp.RequestHandler):
	def get(self, key):
		onRequest(self)
		visitedMember = membership.Member.get(key)
		if visitedMember:
			self.setVisitedMember(visitedMember)
			bookmarks = visitedMember.Bookmarks.fetch(limit=999)
			books = []
			for bookmark in bookmarks:
				books.append(bookmark.Book)
			self.Model.update({
				'bookmarks': bookmarks,
				'books': books
				})
			self.render2('views/members-bookmarks-list.html')
		else: self.error(404)

class MembersNeighborhood(webapp.RequestHandler):
	def get(self, key):
		onRequest(self)
		visitedMember = membership.Member.get(key)
		if visitedMember:
			self.setVisitedMember(visitedMember)
			following = visitedMember.get_relationships_members_from("follower")
			followers = visitedMember.get_relationships_members_to("follower")
			self.Model.update({
				'following': following,
				'followers': followers
				})
			self.render2('views/members-neighborhood.html')
		else: self.error(404)
