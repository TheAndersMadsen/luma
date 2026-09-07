package dk.andersmadsen.cosmos.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp
import dk.andersmadsen.cosmos.android.CreditPart
import dk.andersmadsen.cosmos.android.DisplayCard
import dk.andersmadsen.cosmos.android.DisplayContent
import dk.andersmadsen.cosmos.android.R

/**
 * Renders the delivered card verbatim. Credits are inert tokens: text or one
 * HTTPS link each. [onCommitted] fires once the composition holding the
 * complete card, credits included, has been applied. [onChoose] sends a chosen
 * option's title back as a request; without it the choices are read-only.
 */
@Composable
fun DisplayCardView(card: DisplayCard, onCommitted: (DisplayCard) -> Unit, modifier: Modifier = Modifier, onChoose: ((String) -> Unit)? = null) {
    CosmosCard(modifier) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
            if (card.private) {
                // States the class Cosmos routed at; it is not a claim that nobody else can see the screen.
                Text(stringResource(R.string.private_reply), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                Spacer(Modifier.height(8.dp))
            }
            when (val content = card.content) {
                is DisplayContent.Text -> CosmosMessage(content.text)
                is DisplayContent.Choices -> {
                    Text(content.title, color = CosmosPalette.primary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(10.dp))
                    for (item in content.items) {
                        val label = "${item.id}. ${item.title}"
                        val choose = if (onChoose != null) {
                            Modifier.clickable(role = Role.Button) { onChoose(item.title) }.semantics { contentDescription = label }
                        } else Modifier
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 48.dp).then(choose).padding(vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(item.id, color = CosmosPalette.glow, fontSize = CosmosType.body, modifier = Modifier.width(28.dp))
                            Column {
                                Text(item.title, color = CosmosPalette.primary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine)
                                if (item.detail.isNotBlank()) Text(item.detail, color = CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine)
                            }
                        }
                    }
                }
                is DisplayContent.Places -> {
                    Text(content.query, color = CosmosPalette.primary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(10.dp))
                    if (content.items.isEmpty()) Text(stringResource(R.string.no_places), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                    for (item in content.items) {
                        Text(item.name, color = CosmosPalette.primary, fontSize = CosmosType.body, lineHeight = CosmosType.bodyLine)
                        Text(item.address, color = CosmosPalette.secondary, fontSize = CosmosType.quiet, lineHeight = CosmosType.quietLine)
                        item.sourceUrl?.let { url ->
                            Text(buildAnnotatedString {
                                withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = CosmosPalette.glow, textDecoration = TextDecoration.Underline)))) {
                                    append(stringResource(R.string.view_on_maps))
                                }
                            }, fontSize = CosmosType.quiet, modifier = Modifier.heightIn(min = 44.dp).padding(top = 4.dp))
                        }
                        Spacer(Modifier.height(10.dp))
                    }
                    Spacer(Modifier.height(4.dp))
                    Text(stringResource(R.string.maps_credit), color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                    for (credit in content.credits) {
                        Text(buildAnnotatedString {
                            for (part in credit) when (part) {
                                is CreditPart.Text -> append(part.text)
                                is CreditPart.Link -> withLink(LinkAnnotation.Url(part.href,
                                    TextLinkStyles(SpanStyle(color = CosmosPalette.glow, textDecoration = TextDecoration.Underline)))) { append(part.text) }
                            }
                        }, color = CosmosPalette.secondary, fontSize = CosmosType.quiet)
                    }
                }
            }
        }
    }
    // The effect runs after this composition, including every credit line, is applied.
    LaunchedEffect(card.actionId) { onCommitted(card) }
}
